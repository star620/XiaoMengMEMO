//! 便签里的照片：base64 存盘、格式嗅探、导出带图、清理没人引用的图片。
//!
//! 契约见 docs/images-contract.md：正文里图片占单独一行，写成 `![](xmimg:img_xxx.png)`，
//! 真实文件放在数据目录的 images/ 里。这里**不重编码、不压缩、不生成缩略图**，
//! 原样落盘（前端 <img> 直接显示），所以也不需要 image crate。

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::log_line;
use crate::model::{self, Note};
use crate::store::Store;

/// 单张图片上限（解码后的字节数）
pub const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
/// base64 文本的粗略上限：15MB 数据大约 20MB base64，先卡住长度免得分配巨大字符串
const MAX_BASE64_CHARS: usize = MAX_IMAGE_BYTES / 3 * 4 + 4096;
/// 清理旧图片时给「刚存进来、正文还没保存」的图留的宽限期
const GC_MIN_AGE_MS: i64 = 10 * 60 * 1000;
/// 文件名序号：同一毫秒内连存多张也不会撞名
static NAME_COUNTER: AtomicU64 = AtomicU64::new(1);

/// save_image 命令的实体：base64 → 校验 → 按字节头定扩展名 → 原子写盘，返回文件名。
/// dir 由命令层从数据仓库取（和 notes.json 在同一个数据目录下），测试里可以换成临时目录。
pub fn save_in(dir: &Path, data: &str) -> Result<String, String> {
    let bytes = decode_base64(data)?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片太大了（单张上限 15 MB）".to_string());
    }
    let ext =
        sniff_ext(&bytes).ok_or_else(|| "这个图片格式还不支持（png / jpg / webp）".to_string())?;
    fs::create_dir_all(dir).map_err(|err| format!("创建图片目录失败：{err}"))?;
    save_bytes(dir, &bytes, ext)
}

/// 按字节头判断真实格式（不看前端给的 mime，避免被骗）
fn sniff_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// 临时文件 + rename 原子落盘：写到一半失败也不会留下半张图
fn save_bytes(dir: &Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    for _ in 0..8 {
        let name = format!("img_{}.{ext}", random_hex16());
        let path = dir.join(&name);
        if path.exists() {
            continue;
        }
        let tmp = dir.join(format!("{name}.tmp"));
        let write_result = (|| -> std::io::Result<()> {
            let mut file = fs::File::create(&tmp)?;
            std::io::Write::write_all(&mut file, bytes)?;
            file.sync_all()?;
            fs::rename(&tmp, &path)
        })();
        match write_result {
            Ok(()) => return Ok(name),
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("保存图片失败：{err}"));
            }
        }
    }
    Err("保存图片失败：文件名撞车太多次，请重试".to_string())
}

/// 16 位小写 hex 文件名（契约规定 img_<16 hex>.<ext>）
fn random_hex16() -> String {
    let nanos = model::now_ms().unsigned_abs();
    let counter = NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mixed = mix64(nanos ^ (counter.wrapping_mul(0x9E37_79B9_7F4A_7C15)));
    format!("{mixed:016x}")
}

/// splitmix64：把时间戳和计数器搅匀，省得同一毫秒连存几张同名
fn mix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// base64 解码（容忍换行/空格，容忍 URL-safe 的 -_，也顺手剥掉 data: 前缀）
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("图片数据是空的".to_string());
    }
    // 前端契约是「不带 data: 前缀」，但这里宽容一点，省得某个调用方忘了剥
    let payload = match trimmed.strip_prefix("data:") {
        Some(rest) => rest.split_once(',').map(|(_, data)| data).unwrap_or(rest),
        None => trimmed,
    };
    if payload.len() > MAX_BASE64_CHARS {
        return Err("图片太大了（单张上限 15 MB）".to_string());
    }
    let mut out: Vec<u8> = Vec::with_capacity(payload.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut padding = false;
    for byte in payload.bytes() {
        match byte {
            b'=' => {
                padding = true;
                continue;
            }
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => {}
        }
        if padding {
            return Err("图片数据解不开（base64 格式不对）".to_string());
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return Err("图片数据解不开（base64 格式不对）".to_string()),
        } as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1u32 << bits) - 1;
        }
    }
    if out.is_empty() {
        return Err("图片数据是空的".to_string());
    }
    Ok(out)
}

/// 文件名是否是我们自己生成的图片名（清理时只动这类文件，别误删用户放的东西）
fn is_image_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("img_") else {
        return false;
    };
    let Some((hex, ext)) = rest.rsplit_once('.') else {
        return false;
    };
    if hex.len() != 16
        || !hex
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return false;
    }
    matches!(ext, "png" | "jpg" | "webp")
}

/// 从一段正文里找出所有被引用的图片文件名（按出现顺序去重）
pub fn names_in_text(text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find("xmimg:") {
        rest = &rest[pos + "xmimg:".len()..];
        let end = rest
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-'))
            .unwrap_or(rest.len());
        let name = &rest[..end];
        if is_image_name(name) && !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
        }
        rest = &rest[end..];
    }
    names
}

/// 收集「还被引用」的图片名：便签正文/待办/随身笔记 + 回收站 + 修改记录
fn collect_refs(store: &Store) -> HashSet<String> {
    let mut refs: HashSet<String> = HashSet::new();
    for note in store.all_notes() {
        collect_note_refs(&note, &mut refs);
    }
    for note in store.trash_notes() {
        collect_note_refs(&note, &mut refs);
    }
    // 修改记录（history/*.json）里的旧正文也算引用：恢复到旧版本时图片还得在
    let history_dir = store.dir().join("history");
    if let Ok(entries) = fs::read_dir(&history_dir) {
        for entry in entries.flatten() {
            if let Ok(text) = fs::read_to_string(entry.path()) {
                for name in names_in_text(&text) {
                    refs.insert(name);
                }
            }
        }
    }
    refs
}

fn collect_note_refs(note: &Note, refs: &mut HashSet<String>) {
    for name in names_in_text(&note.content) {
        refs.insert(name);
    }
    for todo in &note.todos {
        for name in names_in_text(&todo.text) {
            refs.insert(name);
        }
    }
    for item in &note.items {
        for text in [&item.label, &item.value, &item.note] {
            for name in names_in_text(text) {
                refs.insert(name);
            }
        }
    }
}

/// 清空回收站之后调用：删掉 images/ 里再也没人引用的图片，返回删掉的张数。
/// 宁可不删：只动 img_<16hex>.(png|jpg|webp)，且跳过最近 10 分钟写入的。
pub fn gc(store: &Store) -> usize {
    let refs = collect_refs(store);
    gc_in(&store.dir().join("images"), &refs, GC_MIN_AGE_MS)
}

fn gc_in(dir: &Path, refs: &HashSet<String>, min_age_ms: i64) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let now = model::now_ms();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_image_name(&name) || refs.contains(&name) {
            continue;
        }
        let too_new = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|age| now - (age.as_millis() as i64) < min_age_ms)
            .unwrap_or(false);
        if too_new {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(err) => log_line(format!("清理没人引用的图片失败（{name}）：{err}")),
        }
    }
    removed
}

/// 导出时把正文引用到的图片复制到 <导出目录>/images/，
/// 并把 Markdown 里的 xmimg: 改写成 images/文件名（说明文字保持不动）。
/// 返回（改写后的 Markdown，成功复制的张数）。复制失败只记日志，不中断导出。
pub fn export_with_images(md: &str, src_dir: &Path, out_dir: &Path) -> (String, usize) {
    export_with_images_in(md, src_dir, out_dir)
}

fn export_with_images_in(md: &str, src_dir: &Path, out_dir: &Path) -> (String, usize) {
    let names = names_in_text(md);
    if names.is_empty() {
        return (md.to_string(), 0);
    }
    let dst_dir = out_dir.join("images");
    if let Err(err) = fs::create_dir_all(&dst_dir) {
        log_line(format!("创建导出图片目录失败：{err}"));
        return (md.to_string(), 0);
    }
    let mut out = md.to_string();
    let mut copied = 0;
    for name in names {
        let src = src_dir.join(&name);
        if !src.is_file() {
            // 图片被手动删了 / 还没落盘：保留原 token，不假装成功
            log_line(format!("导出时找不到图片：{name}"));
            continue;
        }
        match fs::copy(&src, dst_dir.join(&name)) {
            Ok(_) => {
                copied += 1;
                out = out.replace(&format!("xmimg:{name}"), &format!("images/{name}"));
            }
            Err(err) => log_line(format!("复制图片到导出目录失败（{name}）：{err}")),
        }
    }
    (out, copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NoteKind;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!(
                "images-{tag}-{}-{}",
                std::process::id(),
                model::now_ms()
            ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("创建测试目录");
        dir
    }

    const PNG_HEADER_B64: &str = "iVBORw0KGgo=";

    #[test]
    fn base64_能解回原始字节() {
        let bytes = decode_base64(PNG_HEADER_B64).expect("解码");
        assert_eq!(bytes, vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        // data: 前缀、换行、URL-safe 字符都要能容错
        let with_prefix =
            decode_base64("data:image/png;base64,iVBO\nRw0KGgo=").expect("带前缀解码");
        assert_eq!(with_prefix, bytes);
        assert!(!decode_base64("不是base64!").is_ok());
        assert!(!decode_base64("").is_ok());
    }

    #[test]
    fn 按字节头嗅探格式() {
        assert_eq!(sniff_ext(&[0x89, 0x50, 0x4E, 0x47, 0, 0]), Some("png"));
        assert_eq!(sniff_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(sniff_ext(&webp), Some("webp"));
        assert_eq!(sniff_ext(b"GIF89a"), None);
    }

    #[test]
    fn 存图会生成契约规定的文件名并原样落盘() {
        let dir = temp_dir("save");
        let bytes = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4];
        let name = save_bytes(&dir, &bytes, "png").expect("存图");
        assert!(is_image_name(&name), "文件名不合契约：{name}");
        assert_eq!(fs::read(dir.join(&name)).expect("读回"), bytes);
        // 不留临时文件
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .expect("列目录")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "留下了临时文件：{leftovers:?}");
    }

    #[test]
    fn 正文里能找到图片名且去重保序() {
        let content = "第一行\n![](xmimg:img_0123456789abcdef.png \"面包店\")\n![](xmimg:img_0123456789abcdef.png)\n随口提到 xmimg:img_fedcba9876543210.webp 不算整行\n![](xmimg:img_1111222233334444.jpg)";
        let names = names_in_text(content);
        assert_eq!(
            names,
            vec![
                "img_0123456789abcdef.png",
                "img_fedcba9876543210.webp",
                "img_1111222233334444.jpg"
            ]
        );
        assert!(names_in_text("普通文字没有图").is_empty());
    }

    #[test]
    fn 导出会复制图片并改写token() {
        let src = temp_dir("export-src");
        let out = temp_dir("export-out");
        fs::write(src.join("img_0123456789abcdef.png"), b"png-bytes").expect("准备图片");
        let md = "# 标题\n\n![](xmimg:img_0123456789abcdef.png \"说明\")\n\n![](xmimg:img_ffffffffffffffff.png)";
        let (rewritten, copied) = export_with_images_in(md, &src, &out);
        assert_eq!(copied, 1);
        assert!(rewritten.contains("![](images/img_0123456789abcdef.png \"说明\")"));
        // 找不到的图片保持原样，不假装成功
        assert!(rewritten.contains("xmimg:img_ffffffffffffffff.png"));
        assert!(out
            .join("images")
            .join("img_0123456789abcdef.png")
            .is_file());
    }

    #[test]
    fn 清理只删没人引用且不是刚存的图片() {
        let dir = temp_dir("gc");
        let old = dir.join("img_0123456789abcdef.png");
        let kept = dir.join("img_fedcba9876543210.jpg");
        let fresh = dir.join("img_1111222233334444.png");
        let foreign = dir.join("我的照片.png");
        fs::write(&old, b"old").expect("旧图");
        fs::write(&kept, b"kept").expect("被引用的图");
        fs::write(&fresh, b"fresh").expect("刚存的图");
        fs::write(&foreign, b"user").expect("用户自己放的文件");
        // 把 old / kept 的修改时间挪到很久以前，fresh 保持「刚刚」
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        for path in [&old, &kept] {
            fs::File::options()
                .write(true)
                .open(path)
                .expect("打开")
                .set_modified(long_ago)
                .expect("改时间");
        }
        let mut refs = HashSet::new();
        refs.insert("img_fedcba9876543210.jpg".to_string());
        let removed = gc_in(&dir, &refs, GC_MIN_AGE_MS);
        assert_eq!(removed, 1);
        assert!(!old.exists(), "没人引用且时间久远的图应该被删");
        assert!(kept.exists(), "被引用的图不能删");
        assert!(fresh.exists(), "刚存的图要给宽限期");
        assert!(foreign.exists(), "不是我们命名的文件绝不删");
    }

    #[test]
    fn 便签引用的图片名会被收集() {
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.content = "![](xmimg:img_0123456789abcdef.png)".to_string();
        let mut refs = HashSet::new();
        collect_note_refs(&note, &mut refs);
        assert!(refs.contains("img_0123456789abcdef.png"));
    }
}
