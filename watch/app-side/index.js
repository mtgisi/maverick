// Side Service — runs inside the Zepp phone app (which has internet). zml's BaseSideService provides
// the httpRequest relay automatically, so the watch page can call this.httpRequest(...) and zml routes
// it here to perform the real fetch over the phone's connection. No custom handler needed.
import { BaseSideService } from '@zeppos/zml/base-side';

AppSideService(BaseSideService({}));
