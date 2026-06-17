// zml's BaseApp wires the page <-> side-service messaging transport that this.httpRequest relies on.
// Without it, httpRequest from the page has nowhere to go and hangs.
import { BaseApp } from '@zeppos/zml/base-app';

App(BaseApp({
  globalData: {},
  onCreate() {},
  onDestroy() {},
}));
