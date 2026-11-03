/**
 * @file    download.ts
 * @brief   把文本作为文件下载（Blob + a.download），不触碰本地文件系统。
 *
 * 不加 BOM、不做换行转换：生成器输出就是 LF + UTF-8，与库现有文件一致，
 * 下载后直接覆盖 inc/vol_cfg.h、src/vol_cfg.c 即可。
 *
 * 一次触发多个文件时，必须在同一个用户点击内同步发起（不要用 await/定时器错开），
 * 否则浏览器会认为后续下载不是用户意图而拦掉。Chrome 首次会弹出
 * “是否允许下载多个文件”，点允许即可。
 */
export interface DownloadItem {
  filename: string;
  text: string;
}

function triggerOne({ filename, text }: DownloadItem): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立即回收会让某些浏览器拿到空文件，留 10 s
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 下载单个文件 */
export function downloadText(filename: string, text: string): void {
  triggerOne({ filename, text });
}

/** 一次下载多个文件（同步触发，浏览器会合并成一次“多文件下载”提示） */
export function downloadFiles(items: DownloadItem[]): void {
  for (const it of items) triggerOne(it);
}
