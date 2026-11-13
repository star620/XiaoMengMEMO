/**
 * 内联 SVG 图标（不引图片、不引图标库）。
 * 统一 24x24 viewBox、currentColor 描边，尺寸由 CSS 的 .xm-btn svg 控制。
 */
const wrap = (inner: string): string =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";

export const icons = {
  /** 图钉（置顶） */
  pin: wrap('<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 14v7"/>'),
  /** 小铃铛（提醒） */
  bell: wrap('<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  /** 三个点（更多） */
  more: wrap('<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
  /** 勾（待办完成） */
  check: wrap('<path d="M4.5 12.5 9.5 17.5 20 6.5"/>'),
  /** 删除 */
  trash: wrap('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>'),
  /** 时钟 */
  clock: wrap('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  /** 修改记录（回转的时钟） */
  history: wrap('<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 4.5v4.2h4.2"/><path d="M12 7.5V12l3 2"/>'),
  /** 文件夹 */
  folder: wrap('<path d="M3.5 7.5h6l2 2h9v9.5h-17z"/>'),
  /** 加号 */
  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  /** 设置齿轮 */
  gear: wrap('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h5l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.6.1-1Z"/>'),
  /** 便签列表（打开面板：一页纸 + 三条横线） */
  panel: wrap('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 12.5h8M8 16h5"/>'),
  /** 铅笔（编辑） */
  edit: wrap('<path d="M4 20l4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="M13.5 6.5l3 3"/>'),
  /** 眼睛（随身笔记：看明文 / 打码） */
  eye: wrap('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/>'),
  /** 小锁（便签锁定） */
  lock: wrap('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11"/><path d="M12 14.5v2.5"/>'),
  /** 导出（向下箭头落到托盘） */
  download: wrap('<path d="M12 4v10"/><path d="M8 10.5 12 14.5l4-4"/><path d="M5 18.5h14"/>'),
  /** 从备份恢复（回转箭头） */
  restore: wrap('<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 4.5v4.2h4.2"/>'),
  /** 展开（折下来） */
  expand: wrap('<path d="M6 9l6 6 6-6"/>'),
  /** 剪贴板（面板里的"粘贴"） */
  clipboard: wrap('<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9.5 4.5V3.2h5v1.3"/><path d="M9 10h6M9 13.5h6"/>'),
  /** 多选（虚线框 + 勾：面板工具栏进入多选模式） */
  select: wrap('<rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke-dasharray="3.2 3"/><path d="M8.5 12.2 11 14.7l4.6-5.2"/>'),
} as const;
