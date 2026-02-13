# Changelog

## [0.2.0](https://github.com/mbaxszy7/Mnemora/compare/v0.1.0...v0.2.0) (2026-02-13)


### Features

* **splash:** add simulated boot progress with slow start warning ([964903a](https://github.com/mbaxszy7/Mnemora/commit/964903a2539befab9e078b520ccdfc0632ebe477))


### Bug Fixes

* **activity-monitor:** use latest activity timestamp as timeline baseline ([a7f9f45](https://github.com/mbaxszy7/Mnemora/commit/a7f9f45cb3a5a374af4195808f7bac6ed596d1b8))
* **main:** initialize i18n before tray to ensure translations load ([ad6067c](https://github.com/mbaxszy7/Mnemora/commit/ad6067c5a13060e8e8de926a8ac4eb5b91cee252))
* publish-stable workflow tag mismatch with release-please ([42068f6](https://github.com/mbaxszy7/Mnemora/commit/42068f677e0c19edee39c05bb5dc11c10f1326ac))
* resolve merge conflict in main.ts combining Squirrel events and error handlers ([f74119e](https://github.com/mbaxszy7/Mnemora/commit/f74119e55d704beab257d3e6b258494e35679c4e))
* unpack .dll from asar for Windows sharp/libvips and improve inst… ([b810bea](https://github.com/mbaxszy7/Mnemora/commit/b810bea69e81da067cc5f36aa71584e3af785ebe))
* unpack .dll from asar for Windows sharp/libvips and improve installer UX ([b82cdb9](https://github.com/mbaxszy7/Mnemora/commit/b82cdb9f787387910bcc2d14e50f5a4714800e57))
* **use-activity-monitor:** use latestToTsRef as default baseline on r… ([150d95c](https://github.com/mbaxszy7/Mnemora/commit/150d95c9730ff6d560e171ef23d7f54c74e8d894))
* **use-activity-monitor:** use latestToTsRef as default baseline on refresh ([c07726f](https://github.com/mbaxszy7/Mnemora/commit/c07726f520bd4d39ed7fd36e986fdf7c4212476f))
* win platform installer ([55f697b](https://github.com/mbaxszy7/Mnemora/commit/55f697b12efec03260af28701a21df6e78ef85f8))
* win platform installer ([a9fb5da](https://github.com/mbaxszy7/Mnemora/commit/a9fb5da6c556eae48406fc3c7c0c9af9ec5f1070))
* **win:** add Squirrel startup events for ARM64 install and tray i18n refresh ([2606af8](https://github.com/mbaxszy7/Mnemora/commit/2606af8f62847055c31f410b5ec12408489d96f0))
* **win:** add Squirrel startup events for ARM64 install and tray i18n… ([8f9fe13](https://github.com/mbaxszy7/Mnemora/commit/8f9fe138761187bf127ecccd3594e2d469b5cea9))
* **win:** use app name as Windows AUMID for notification title ([2f39bdd](https://github.com/mbaxszy7/Mnemora/commit/2f39bdd0f91aaab18131a120cb9f294f23c9430d))
* **win:** use app name as Windows AUMID for notification title ([a71ed10](https://github.com/mbaxszy7/Mnemora/commit/a71ed10f94595ba2a7358ad8056c41076aff9997))


### Performance Improvements

* optimize startup by deferring non-essential imports to dynamic import() ([b1a5c0d](https://github.com/mbaxszy7/Mnemora/commit/b1a5c0d89d972d38a7b0f6a02a5e4147e38674da))

## [0.1.0](https://github.com/mbaxszy7/Mnemora/compare/mnemora-v0.0.1...mnemora-v0.1.0) (2026-02-08)


### Features

* add app splash page ([3a60fa7](https://github.com/mbaxszy7/Mnemora/commit/3a60fa7ac1068f5e612b48b3b92c8db8d5dc72e6))
* add core services and modules for AI-driven screenshot processing ([e91ff99](https://github.com/mbaxszy7/Mnemora/commit/e91ff9991f9409cd545116927013c2cf26c04d58))
* add LLM usage tracking and display, new screenshot processing services ([684bbb2](https://github.com/mbaxszy7/Mnemora/commit/684bbb2a529b6f2e1ddeaea2321fb0b248757494))
* add page view transition ([dcf1b69](https://github.com/mbaxszy7/Mnemora/commit/dcf1b69400d486e703ddce33678f3800f64cbf90))
* **capture:** add screen and app filtering with user preferences ([4717f4b](https://github.com/mbaxszy7/Mnemora/commit/4717f4b06bda0c7f0fb474f66272894a31dee3f6))
* **capture:** add screen and app filtering with user preferences integration ([fdd8d73](https://github.com/mbaxszy7/Mnemora/commit/fdd8d73a8486d596986e8b1258327f849edef49c))
* **db:** add better-sqlit3 and drizzle orm ([5600074](https://github.com/mbaxszy7/Mnemora/commit/56000742337df3b62c4c67e67521a073889dfd89))
* **fts5:** implement FTS5 self-healing with splash progress and degraded mode ([071ab79](https://github.com/mbaxszy7/Mnemora/commit/071ab7952bd4cb4529a0afb4c8606726e806c00e))
* **i18n:** add internationalization support with language switching ([bee0982](https://github.com/mbaxszy7/Mnemora/commit/bee09822a4bf814e8b5afc15a221a74cbde407b6))
* implement a reconcile loop for robust screenshot processing, entity extraction ([15f9614](https://github.com/mbaxszy7/Mnemora/commit/15f9614989495389c9c679afa0747bd92ab8a6de))
* implement activity monitor dashboard with timeline, search, and summary panel ([6856bb6](https://github.com/mbaxszy7/Mnemora/commit/6856bb60e536cbde6600795fdbbaedd67dd63d2a))
* implement activity monitor, AI failure circuit breaker, and enhance screenshot processing ([d9d3d92](https://github.com/mbaxszy7/Mnemora/commit/d9d3d9252e2d9d60418734ed72ac706f92bc2c78))
* implement activity monitoring, deep search, and LLM-driven context processing ([af2a0a3](https://github.com/mbaxszy7/Mnemora/commit/af2a0a35c8833bb18e782fd6534b9357df137500))
* implement context graph, deep search, and LLM usage tracking ([b49955b](https://github.com/mbaxszy7/Mnemora/commit/b49955b7b96bce22384497ccd14d6b76fe835e4c))
* implement core components for the new screenshot processing pipeline ([a5aee49](https://github.com/mbaxszy7/Mnemora/commit/a5aee497f3ab46973f918ddf57a858663f7a72b0))
* implement initial alpha version of the screenshot processing ([ebe648c](https://github.com/mbaxszy7/Mnemora/commit/ebe648c82b9c85ed79de4de817a1bf9118ccd388))
* implement initial Electron app with screen capture, LLM/VLM processing, vector indexing ([9dc261b](https://github.com/mbaxszy7/Mnemora/commit/9dc261b4c4100a4dd8c92b114c785a5f2bf84041))
* implement new screenshot processing alpha service with VLM, OCR, and various schedulers ([6d7ad84](https://github.com/mbaxszy7/Mnemora/commit/6d7ad84165035363b1a40c787d9cada79dc16420))
* implement new VLM-powered screenshot processing with vector indexing ([79f1982](https://github.com/mbaxszy7/Mnemora/commit/79f198231f23564a72126c87aa26a34d1e098afb))
* implement screenshot processing pipeline with context graph and search capabilities ([96a70b3](https://github.com/mbaxszy7/Mnemora/commit/96a70b331174af323af0845200ebd0786a96f070))
* implement the initial screenshot processing pipeline ([0aff68f](https://github.com/mbaxszy7/Mnemora/commit/0aff68fac3812e624be8c6abf8055937e2176e12))
* improve activity processing, context search, internationalization support ([10fadbd](https://github.com/mbaxszy7/Mnemora/commit/10fadbd8cc9d96e558016fdc7c0bb3c34edd2236))
* improve activity timeline scheduling with VLM completion-based seeding ([9f0e535](https://github.com/mbaxszy7/Mnemora/commit/9f0e53599b284d6a72b840621fcdac691f55f989))
* introduce a new monitoring system with web-based dashboards ([82b3e81](https://github.com/mbaxszy7/Mnemora/commit/82b3e81fa7288edf46d4c6875f0c3c1e74b18f78))
* introduce adaptive AI concurrency tuning for VLM, text, and embedding models ([2ef2289](https://github.com/mbaxszy7/Mnemora/commit/2ef22895b09651b570a28c102e7a8f71a192f09b))
* introduce AI request tracing and monitoring ([f72b5d9](https://github.com/mbaxszy7/Mnemora/commit/f72b5d908c7a54c0284d62795a1f1655c07a3e5e))
* introduce VLM-based application guessing for screenshots and update database app hints ([f88e9c5](https://github.com/mbaxszy7/Mnemora/commit/f88e9c575ffd637f9ba35d42c667e30847c01dda))
* **llm-config:** add LLM configuration management with unified/separate modes ([d0f40ff](https://github.com/mbaxszy7/Mnemora/commit/d0f40ffe0e5fa28f74ada1a24f61d08198e9e203))
* **onboarding:** add guided onboarding for home and settings ([a5a4a62](https://github.com/mbaxszy7/Mnemora/commit/a5a4a624275ca194d40432da4df758c622c9acfd))
* **onboarding:** add guided onboarding for home and settings ([b99aff3](https://github.com/mbaxszy7/Mnemora/commit/b99aff3851ffc21436ded6414960eccba29d4c18))
* **release:** add macos signing and notarization pipeline ([6ddef6f](https://github.com/mbaxszy7/Mnemora/commit/6ddef6ff50cd39ed4d8a2c35ff37e4a6b285c896))
* **release:** add release-please flow and app update service ([2ee201f](https://github.com/mbaxszy7/Mnemora/commit/2ee201fa371d4327f322e8d4c97715445a6d926a))
* **release:** automate stable releases and app updates ([f1b3eb2](https://github.com/mbaxszy7/Mnemora/commit/f1b3eb2ab8223ec234cfe91b037d9d5c14f028c5))
* **schema,docs:** add retry/backoff fields to context_nodes and vector_documents ([869335e](https://github.com/mbaxszy7/Mnemora/commit/869335e9b5a5ae69df56192f7d6b7513c5833e08))
* screen-capture feature ([3e91410](https://github.com/mbaxszy7/Mnemora/commit/3e914108f36a3487669d42dc60f5be803225f402))
* **splash:** ensure navigation after timeout regardless of config check status ([0ba5ffd](https://github.com/mbaxszy7/Mnemora/commit/0ba5ffd434ba262aa5b9fb9adc6a63fa4c47ec8c))
* **tray:** add system tray in mac ([12a2d48](https://github.com/mbaxszy7/Mnemora/commit/12a2d481eb37aca906d7c1444fafeaf3b2d83f97))
* **tray:** add system tray with recording controls and window management ([54690fe](https://github.com/mbaxszy7/Mnemora/commit/54690fe0c2f3f7f85b3d5784454fdc39d7578709))
* **ui:** add theme system with preload script and improve logging in production ([380bb54](https://github.com/mbaxszy7/Mnemora/commit/380bb548bdde94ab12c4c8c89f4c9f7bdc691407))
* **update:** nightly channel updates and mac packaging symlink fix ([69e5988](https://github.com/mbaxszy7/Mnemora/commit/69e59889c128695cfafc5e90db332a6634bc4bc3))
* **update:** notify on update available and download ready ([8eb29d5](https://github.com/mbaxszy7/Mnemora/commit/8eb29d59406d4539cd0ddf68f3b92f823d6959db))
* **update:** support nightly channel detection and branding ([bb37ac2](https://github.com/mbaxszy7/Mnemora/commit/bb37ac2b5c6b310c92b2b3ac3941570d3a7a1b5b))
* **vlm:** integrate LangChain prompt templates and improve VLM service ([15a0fc6](https://github.com/mbaxszy7/Mnemora/commit/15a0fc6ef05599db254d5d83884b8cac5807ccfc))
* **window-inspector:** add Python-based window inspector with build script ([41fff1b](https://github.com/mbaxszy7/Mnemora/commit/41fff1befa1d0c83371018fc3932c8df5132cbd6))
* **wip-screen-capture:** app window capture refactoring ([e08a186](https://github.com/mbaxszy7/Mnemora/commit/e08a186a4105f30d1e45d3b0faf78ba5487a1577))
* **wip-screen-capture:** app window capture refactoring ([03cba21](https://github.com/mbaxszy7/Mnemora/commit/03cba2194b2bdc7fd80c7ba8c351f8d810d329a0))


### Bug Fixes

* **build:** normalize inspector symlinks and harden nightly publish ([9a38e5d](https://github.com/mbaxszy7/Mnemora/commit/9a38e5d3b5ca7b17498964b88c942f5e75c4756d))
* **build:** rewrite inspector symlinks and revert apple signing workflow ([9208da6](https://github.com/mbaxszy7/Mnemora/commit/9208da619ee48d725c452eb5b9271e3ebe056e46))
* **ci:** detect nightly app bundle name in mac signature check ([a6d5442](https://github.com/mbaxszy7/Mnemora/commit/a6d5442d1155b93f60db7c4ac8375b20499532fe))
* **ci:** install dependencies with scripts for coverage ([138256a](https://github.com/mbaxszy7/Mnemora/commit/138256a6d356afd383901e82baf73b8786750e77))
* **ci:** pin node 20 + python 3.11 ([761aed7](https://github.com/mbaxszy7/Mnemora/commit/761aed765ee6d9c408ea86a4cf08d497929f6b41))
* **ci:** stabilize window_inspector build ([d397226](https://github.com/mbaxszy7/Mnemora/commit/d397226bc7bdf94e4668dc68a2f9ea4e01f9f19b))
* **ci:** track window_inspector spec ([cd606e0](https://github.com/mbaxszy7/Mnemora/commit/cd606e0bc5eac1c33f0ceb7db78b94b29aeecd99))
* **db:** auto recover sqlite corruption in OCR pipeline ([dbb5279](https://github.com/mbaxszy7/Mnemora/commit/dbb5279a9e666ddb0722826763d4503bb541c632))
* **db:** auto-recover sqlite corruption for OCR pipeline ([a5d3749](https://github.com/mbaxszy7/Mnemora/commit/a5d3749198cf8778d85ff6350b8fbc7284399201))
* deep search ([82a6b31](https://github.com/mbaxszy7/Mnemora/commit/82a6b31e242738b6e701c504e626a801172509c8))
* **logger:** tolerate locked log cleanup during tests ([75dc1b1](https://github.com/mbaxszy7/Mnemora/commit/75dc1b1f752ff9d5e1a7211a2c76fc1a5aab4ae2))
* **mac-build:** re-sign packaged app bundle after hooks ([159afb1](https://github.com/mbaxszy7/Mnemora/commit/159afb1a6cdb342dd03c87f0a0c69cea0c836ea1))
* **mac:** align nightly identity for permissions and title ([2a906e5](https://github.com/mbaxszy7/Mnemora/commit/2a906e554d759ad1fe22b88929a7ae2053843da0))
* **mac:** separate nightly app identity and title ([48233c2](https://github.com/mbaxszy7/Mnemora/commit/48233c28f3ae5bc7f1241892c9181b74dde818ab))
* **nightly:** clean assets, normalize names, and compare build sha ([572ed02](https://github.com/mbaxszy7/Mnemora/commit/572ed022a07dc2a5c65ad0ebdd0d89df66db5552))
* **nightly:** normalize windows asset names by artifact path ([5d12773](https://github.com/mbaxszy7/Mnemora/commit/5d1277313adf8f602959c148fc304adba6e3b5f7))
* **nightly:** stabilize packaging, asset publishing, and update checks ([98f266d](https://github.com/mbaxszy7/Mnemora/commit/98f266d4a030423768c45ca014c1211ddd7506e0))
* **notification:** macOS notification icon and window focus ([cd36163](https://github.com/mbaxszy7/Mnemora/commit/cd3616392e99bbb131ab95c2925a1ca5fcea5d3f))
* **release:** correct nightly channel/version and windows setup assets ([ea2cbb5](https://github.com/mbaxszy7/Mnemora/commit/ea2cbb5f1632bbe68262e7888f550adb02bb34b1))
* **update:** prevent concurrent windows checks and nightly asset collisions ([d6e6033](https://github.com/mbaxszy7/Mnemora/commit/d6e6033b05e8bcd5757e72bd69d2aceace66a91e))
* use RELEASE_PLEASE_TOKEN for release-please action ([a77d609](https://github.com/mbaxszy7/Mnemora/commit/a77d609367b1828d3b5455946cd3692352d5cf8a))
* use RELEASE_PLEASE_TOKEN for release-please action ([e78060c](https://github.com/mbaxszy7/Mnemora/commit/e78060cefc1ba234adb35a7ec7022347919c7b5d))
