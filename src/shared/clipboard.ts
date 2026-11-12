/**
 * 把文字写进系统剪贴板。
 * 桌面端（WebView2）和普通浏览器都先试 navigator.clipboard；
 * 某些环境（老 WebView、无权限）会失败，退回 textarea + execCommand("copy")。
 *
 * 返回 true 表示确实复制成功，调用方据此决定要不要显示「已复制」。
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? "");
  if (!value) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 没权限或被系统拦下，继续走下面的兜底
  }

  // 兜底：临时 textarea 选中 + execCommand。部分 WebView 只认这条老路。
  let area: HTMLTextAreaElement | null = null;
  const previous = document.activeElement as HTMLElement | null;
  try {
    area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // 不管成功还是异常，都别把临时 textarea 留在页面上，焦点也还给原来的元素
    area?.remove();
    previous?.focus?.();
  }
}
