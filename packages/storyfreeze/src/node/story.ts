// Story shape retained from storycrawler while its MIT-licensed runtime is internalized.
// Source: https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
export type Story = {
  id: string;
  kind: string;
  story: string;
  version: 'v5';
  viewportProfileHint?: string;
};
