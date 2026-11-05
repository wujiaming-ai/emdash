import { dialog } from 'electron';

export async function chooseDownloadDirectory(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: 'Download to…',
    buttonLabel: 'Download here',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? undefined : result.filePaths[0];
}
