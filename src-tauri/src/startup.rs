//! 启动前的环境检查；只读取进程身份，不改变权限或系统设置。

/// 低完整性进程不能写入原有用户数据目录，不能让它悄悄切到一份空数据后常驻。
pub fn launch_restriction() -> Option<&'static str> {
    #[cfg(windows)]
    match current_integrity_rid() {
        Ok(rid) => {
            crate::boot_log(&format!("startup: integrity_rid=0x{rid:x}"));
            if rid < 0x2000 {
                return Some(
                    "小梦当前的运行权限受限，没能访问原有便签。\n\n请关闭此提示，按发布包内的《启动说明》解压到普通应用目录后再启动。\n在同一个受限目录中更换启动脚本，仍可能遇到此问题。",
                );
            }
        }
        Err(err) => crate::boot_log(&format!("startup: 读取进程完整性失败：{err}")),
    }
    None
}

#[cfg(windows)]
fn current_integrity_rid() -> std::io::Result<u32> {
    use std::ffi::c_void;
    use std::io::{Error, ErrorKind};
    use std::ptr;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            kind: u32,
            data: *mut c_void,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn GetSidSubAuthorityCount(sid: *const c_void) -> *const u8;
        fn GetSidSubAuthority(sid: *const c_void, index: u32) -> *const u32;
    }

    struct Token(*mut c_void);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_INTEGRITY_LEVEL: u32 = 25;
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(Error::last_os_error());
    }
    let token = Token(token);
    let mut needed = 0;
    unsafe {
        GetTokenInformation(
            token.0,
            TOKEN_INTEGRITY_LEVEL,
            ptr::null_mut(),
            0,
            &mut needed,
        );
    }
    if needed < std::mem::size_of::<*const c_void>() as u32 {
        return Err(Error::last_os_error());
    }
    let mut buffer = vec![0u8; needed as usize];
    if unsafe {
        GetTokenInformation(
            token.0,
            TOKEN_INTEGRITY_LEVEL,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(Error::last_os_error());
    }
    // TOKEN_MANDATORY_LABEL 的第一个字段是 SID_AND_ATTRIBUTES.Sid。
    // 使用 read_unaligned，避免依赖 Vec<u8> 的分配对齐。
    let sid = unsafe { ptr::read_unaligned(buffer.as_ptr().cast::<*const c_void>()) };
    if sid.is_null() {
        return Err(Error::new(ErrorKind::InvalidData, "完整性 SID 为空"));
    }
    let count = unsafe { *GetSidSubAuthorityCount(sid) };
    if count == 0 {
        return Err(Error::new(ErrorKind::InvalidData, "完整性 SID 没有级别"));
    }
    Ok(unsafe { *GetSidSubAuthority(sid, u32::from(count) - 1) })
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn 可以查询自己的完整性级别而无需修改权限() {
        super::current_integrity_rid().expect("当前进程令牌允许只读查询");
    }
}
