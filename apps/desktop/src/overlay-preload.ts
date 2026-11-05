/**
 * 截图覆盖层的 preload。只暴露三个动作：取配置、交选区、取消。
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  config: () => ipcRenderer.invoke('overlay-config'),
  finish: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('overlay-finish', rect),
  cancel: () => ipcRenderer.send('overlay-cancel'),
};

contextBridge.exposeInMainWorld('overlay', api);

export type OverlayApi = typeof api;
