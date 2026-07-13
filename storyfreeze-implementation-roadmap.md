# StoryFreeze 実装ロードマップ

- 文書版: 0.2-draft
- 作成日: 2026-07-11
- 更新日: 2026-07-12
- ベースリポジトリ: `huuyafwww/storycapture`
- 新プロジェクト名: **StoryFreeze**
- npm パッケージ候補: `storyfreeze`
- CLI: `storyfreeze`
- 対象: Storybook 10 / Chromium / Playwright
- ステータス: Phase 5B実装中

## 1. 結論

StoryFreeze は、`huuyafwww/storycapture` を fork し、次の順序で段階移行する。

```text
Phase 0: fork・改名・現行挙動の固定
   ↓
Phase 1: Storybook 10 対応（Puppeteerのまま）
   ↓
Phase 2: pnpm 移行
   ↓
Phase 3: Vite+・Vitest 導入
   ↓
Phase 4: Oxlint・Oxfmt 導入
   ↓
Phase 5: Playwright 移行
   ↓
Phase 6: Playwright最適化・1.0安定化
```

現在の主ロードマップは、以下の順序とする。

> **Storybook 10 → pnpm → Vite+ / Vitest → Oxlint / Oxfmt → Playwright**

当初予定していた `@antfu/eslint-config` は採用せず、Vite+に統合されたOxlintとOxfmtをlint・formatの正とする。

Phase 0 は製品機能の移行ではなく、比較基準を作る準備工程である。

各Phaseは独立したPR群とし、前後の技術移行を同じPRへ混在させない。特に、Storybook対応とブラウザドライバ変更、pnpmとVite+、Vite+のtask orchestrationとtest/lint/format移行を同時に行わない。

## 2. ベースリポジトリの現状

計画策定時点の `huuyafwww/storycapture` は、Storybook 9対応のStorycap派生実装である。主な状態は次のとおり。

- npmパッケージ名は `storycapture@9.0.0`
- CLI名は `storycapture`
- Storybook peer dependencyは `^9.0.0`
- Node.js要件は `>=18`
- Puppeteerを使用
- `puppeteer-core@^9.0.0` と `storycrawler@^5.0.1` に依存
- CJSとESMの二重ビルド
- Yarn workspacesとLerna 4を使用
- Jest、ESLint 8、Prettierを使用
- 単一の公開パッケージを `packages/storycapture` に配置

このため、Playwrightへの単純なimport置換だけでは移行できない。特に `storycrawler` がストーリー列挙、Storybookとの通信、Puppeteer操作、レンダリング安定待ちの一部を保持しているため、Storybook 10対応フェーズで依存を解消する必要がある。

## 3. プロジェクト契約

### 3.1 独立プロジェクトとしての表記

StoryFreezeは、StorycapまたはStorycaptureの公式後継を名乗らない。

READMEには、少なくとも次の趣旨を明記する。

> StoryFreeze is an independent project based on huuyafwww/storycapture, which was originally forked from reg-viz/storycap. It is not an official successor to either project.

既存のMIT LICENSE、著作権表示、由来の履歴を保持する。コピーまたは改変したファイルに個別の著作権表示がある場合は削除しない。

### 3.2 初期パッケージ構成

初期段階では公開パッケージを分割しない。

```text
repository: storyfreeze
package:    storyfreeze
CLI:        storyfreeze
workspace:  packages/storyfreeze
```

将来の分割を可能にするため、内部ディレクトリは責務別にする。

```text
packages/storyfreeze/src/
├─ cli/
├─ core/
├─ storybook/
├─ browser/
│  ├─ puppeteer/
│  └─ playwright/
├─ capture/
├─ stability/
└─ output/
```

`@storyfreeze/core` や `@storyfreeze/playwright` などの複数公開パッケージ化は、1.0後に実需要が確認できるまで行わない。

### 3.3 名前と公開API

ブランド名だけを変更し、撮影設定の概念は不要に変更しない。

保持するAPI:

- `withScreenshot`
- `isScreenshot`
- `ScreenshotOptions`
- `Variants`
- `Viewport`
- `parameters.screenshot`
- simple mode
- managed mode
- variants、viewports、include、exclude、shard
- 出力ディレクトリ構造とファイル名

新しいパッケージとCLIは次とする。

```bash
pnpm add -D storyfreeze
pnpm exec storyfreeze http://localhost:6006
```

`storycapture` CLIの別名は提供しない。旧パッケージとの同時インストール時に `node_modules/.bin` の衝突を起こし得るためである。

必要であれば、非破壊な別名として将来 `withStoryFreeze` を追加できるが、`withScreenshot` を1.0前に非推奨化しない。

### 3.4 Node.js契約

開発環境と、公開パッケージ利用者の実行環境を分離する。

| 対象                      | Node.js契約                   |
| ------------------------- | ----------------------------- | --- | ---------- |
| StoryFreeze利用者         | `>=22`                        |
| StoryFreezeリポジトリ開発 | `^22.18.0                     |     | >=24.11.0` |
| 通常CI                    | Node 22.18系および24.11系以上 |
| consumer smoke            | Node 22系、npmを使用          |

理由:

- Storybook 10はNode 20.19以上または22.12以上を要求する。
- Vite+ 0.2系列はNode `^22.18.0 || >=24.11.0` を要求する。
- pnpm 11もNode 22以上を要求する。

ルートのprivate packageには開発用Nodeを固定し、公開される `packages/storyfreeze/package.json#engines.node` は `>=22` とする。

Node 22のconsumer smokeでは、Vite+やpnpm 11を実行しない。生成済みtarballをnpmでインストールし、CLIとaddonが実行できることを確認する。

## 4. リリース戦略

最初の公開版はStorybook 10対応が完了した後とする。Storybook 9向けのStoryFreezeは公開しない。

| Milestone       | npm dist-tag | 内容                                        |
| --------------- | ------------ | ------------------------------------------- |
| `0.1.0-alpha.x` | `next`       | Storybook 10 + Puppeteer                    |
| `0.2.0-alpha.x` | `next`       | pnpm移行済み                                |
| `0.3.0-alpha.x` | `next`       | Vite+・Vitest導入済み                       |
| `0.4.0-alpha.x` | `next`       | Oxlint・Oxfmt導入済み                       |
| `0.5.0-alpha.x` | `next`       | Playwright opt-in                           |
| `0.9.0`         | `latest`候補 | Playwrightデフォルト、Puppeteer互換経路あり |
| `1.0.0`         | `latest`     | Puppeteer削除、公開契約安定化               |

ツールチェーンだけが変わるPhase 2〜4では、必ずしも各段階をnpmへ公開する必要はない。Git tagとGitHub Releaseを切り、package smokeを通してから次へ進めればよい。

## 5. Phase 0 — Fork、改名、比較基準の固定

### 5.1 目的

後続の各移行による差を判定できるようにする。ここではStorybook、パッケージマネージャー、ビルド、lint、ブラウザ実装を変更しない。

### 5.2 実装項目

#### PR-000: Forkと由来の明記

- `huuyafwww/storycapture` をfork
- リポジトリを `storyfreeze` へ改名
- README冒頭に独立プロジェクトである旨と由来を記載
- MIT LICENSEと既存著作権表示を保持
- GitHub description、topics、issue templateを更新
- SECURITY.md、CODE_OF_CONDUCT.mdを追加

このPRではnpmパッケージ名、CLI名、ソースコードの識別子を変更しない。

#### PR-001: Baselineの記録

`baseline.json` を追加する。

```json
{
  "upstream": "huuyafwww/storycapture",
  "commit": "<PINNED_SHA>",
  "package": "storycapture@9.0.0",
  "node": "<VERSION>",
  "chromium": "<VERSION>",
  "osImage": "<IMAGE_DIGEST>",
  "capturedAt": "<ISO-8601>"
}
```

次の挙動をcharacterization testとして固定する。

- simple / managed mode
- story列挙順
- include / exclude
- shard
- variantsの継承
- 複数viewport
- hover / focus / click
- delay / waitAssets / waitFor
- fullPage / clip / omitBackground
- skip
- 出力パスとファイル名
- retry / timeout
- trace有無
- serverCmdの起動と終了
- SIGINT / SIGTERM時のブラウザ回収

#### PR-002: 既知のライフサイクル不具合修正

移植前に次を単独で修正する。

- workerの `close()` を実際に呼びawaitする
- `finally` でworker停止とconnection切断をawaitする
- ストーリー列挙用ブラウザを全終了経路で回収する
- ResourceWatcherをURL単位の完了キャッシュではなく、request単位のin-flight管理へ変更する
- PNG書き込みを一時ファイルからのatomic renameにする

### 5.3 完了条件

- ベースコミット、Chromium、OS imageが固定されている
- 主要機能のcharacterization testがある
- テスト終了後にChromiumプロセスが残らない
- 既存fixtureのPNG名と枚数が変更されていない

## 6. Phase 1 — Storybook 10対応

### 6.1 目的

PuppeteerのままStorybook 10へ対応する。ブラウザドライバ変更による差を混ぜない。

### 6.2 破壊的変更

新しいStoryFreezeパッケージは次を前提とする。

- Storybook 10のみを公式対応
- ESM-only
- CommonJS `require()` 非対応
- Node.js `>=22`
- package名 `storyfreeze`
- CLI名 `storyfreeze`

### 6.3 実装項目

#### PR-100: StoryFreezeへのコード改名

- `packages/storycapture` を `packages/storyfreeze` へ変更
- package名を `storyfreeze` へ変更
- CLIを `storyfreeze` へ変更
- 環境変数prefixを `STORYFREEZE_` に変更
- owned global/event prefixを `storyfreeze:` に変更
- キャッシュ・一時ディレクトリを `.storyfreeze` に変更
- README、MIGRATION.md、CLI helpを更新

既存の `ScreenshotOptions` と `parameters.screenshot` は維持する。

#### PR-101: ESM-onlyパッケージ化

- `type: "module"` を設定
- CJS用tsconfigと `lib/` 出力を削除
- `lib-esm` / `lib` の二重出力を、単一の `dist/` に統合
- `register.js` のCommonJS shimを削除
- package exportsをESMとして再定義
- shebang付きCLIの実行確認
- source mapとdeclaration mapを生成
- `npm pack` のcontents snapshotを追加

想定exports例:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./preview": {
      "types": "./dist/storybook/preview.d.ts",
      "import": "./dist/storybook/preview.js"
    }
  },
  "bin": {
    "storyfreeze": "./dist/cli.js"
  }
}
```

最終的なaddon entry構成はStorybook 10のaddon規約に合わせる。

#### PR-102: Storybook 10 fixture

最初にStorybook 10 fixtureを作り、既存コードがどこで失敗するかをテストとして記録する。

必須fixture:

- React + Vite: release blocker
- Vue 3 + Vite: smoke
- Web Components + Vite: smoke

各fixtureで以下を持つ。

- 通常story
- docs entry
- async render
- font/image読み込み
- play function
- screenshot parameters
- variants / viewports
- hover / focus / click対象
- console warning / error

#### PR-103: StoryIndexProvider

Storybookの非公開globalからの列挙を廃止する。

```ts
interface StoryDescriptor {
  id: string;
  title: string;
  name: string;
  tags?: readonly string[];
  importPath?: string;
}

interface StoryIndexProvider {
  load(baseUrl: URL, signal?: AbortSignal): Promise<readonly StoryDescriptor[]>;
}
```

実装契約:

- 第一経路は `${baseUrl}/index.json`
- `entries` から `type === "story"` のみを抽出
- docs entryを撮影対象へ混入させない
- IDで安定ソートしてからinclude/exclude/shardを適用
- HTTP status、JSON schema、重複IDを検証
- `stories.json` fallbackを置く場合はlegacy adapter内に限定
- `window.__STORYBOOK_CLIENT_API__`、`window.__STORYBOOK_PREVIEW__` 等へ依存しない

#### PR-104: StoryNavigatorとPreview Protocol

ストーリー表示とmanaged modeをStoryFreeze所有の契約へ変更する。

基本URL:

```text
/iframe.html?id=<story-id>&viewMode=story
```

StoryFreeze preview側は、バージョン付きのhandshakeを公開する。

```ts
interface StoryFreezePreviewStateV1 {
  protocolVersion: 1;
  addonVersion: string;
  storyId: string;
  status: 'booting' | 'ready' | 'error';
  options?: NormalizedScreenshotOptions;
  error?: SerializedError;
}
```

実装はcustom event、owned global、bindingのいずれでもよいが、次を守る。

- Storybookの非公開globalを使用しない
- `protocolVersion` を必須にする
- storyIdの一致を検証する
- 古いstoryのreadyを誤受理しない
- timeout時に現在のURL、storyId、preview stateを診断出力する
- Node側とpreview側のversion不一致を明示エラーにする

manager pageへ移動してmanaged modeを判定する方式は廃止する。iframe上でStoryFreeze preview handshakeが成立するかを判定する。

#### PR-105: `storycrawler` 依存の解消

`storycrawler` のうち必要な責務をStoryFreeze内部へ移す。

対象:

- Storybook connection
- story preview navigation
- metrics watcher
- resource watcher
- sleep / timeout utility
- device descriptor解決

規則:

- コードをコピーする場合はMIT由来を保持する
- 公開APIとして `storycrawler` 互換層を作らない
- `storycrawler` の型をStoryFreezeの公開型へ出さない
- Phase 1終了時に `dependencies.storycrawler` を削除する
- Puppeteer型の隔離はPhase 5で行うため、この段階では内部利用を許可する

#### PR-106: Storybook 10 addon packaging

- Storybook 10向けpreview entryを提供
- 必要な場合のみmanager entryを提供
- addon登録のno-op globalを廃止
- package metadataへ `storybook-addon` keywordを先頭に設定
- package tarballからfixtureにaddonをインストールするsmoke testを追加
- ローカルworkspace参照だけでテストを通さない

#### PR-107: Storybook 10 E2E gate

Storybook static buildを1回生成し、simple / managedの各実行で再利用する。

- simple mode
- managed mode
- 全story列挙
- include/exclude/shard
- variants/viewports
- assets/fonts
- play function完了後の撮影
- timeout/retry
- serverCmd
- package tarball install

### 6.4 Phase 1で禁止すること

- Playwrightを依存へ追加しない
- BrowserContext共有を実装しない
- pnpmへ変更しない
- Lerna/Yarnを削除しない
- ESLint/Prettier設定を刷新しない
- Chromiumのメジャーバージョンを意図なく更新しない
- 画像命名規則を変更しない

### 6.5 完了条件

- Storybook 10 React/Vite fixtureがstatic build再利用で通る
- Storybook非公開globalへの依存がない
- `storycrawler` 依存がない
- packageがESM-onlyである
- Node 22 consumer smokeが通る
- Puppeteer版の既存画像契約を維持している
- `0.1.0-alpha.0` を `next` へ公開できる

## 7. Phase 2 — pnpm移行

### 7.1 目的

Yarn workspacesとLerna 4を撤去し、後続のVite+導入に適したworkspaceへ変更する。製品コードと配布物の内容は変更しない。

### 7.2 実装項目

#### PR-200: pnpm workspace化

- `pnpm-workspace.yaml` を追加
- workspace対象を `packages/*` と `examples/*` に設定
- `packageManager` にpnpmの完全なversionを固定
- `pnpm-lock.yaml` を生成
- `yarn.lock` を削除
- root `workspaces` フィールドはpnpm構成へ整理
- internal dependencyには `workspace:` protocolを使用
- phantom dependencyを修正
- `shamefully-hoist` を使用しない

#### PR-201: Lerna撤去

root scriptsをpnpm recursive/filterへ置換する。

```text
lerna run build    → pnpm -r build
lerna run test     → pnpm -r test
lerna exec ...     → pnpm -r exec ...
lerna publish      → Changesetsまたは明示的なnpm publish workflow
```

- `lerna.json` を削除
- `lerna` dependencyを削除
- release workflowを独立させる
- package build順序を明示する

#### PR-202: install scriptの承認

pnpmのbuild script制御を明示する。

- `pnpm approve-builds` の結果をreview
- Puppeteer、esbuild等のpostinstallを必要性に応じて許可
- 許可対象を最小化
- CIでは `pnpm install --frozen-lockfile` を使用
- lockfile変更を伴わないinstallを保証

#### PR-203: リリース管理

推奨はChangesetsを使用する。

- `@changesets/cli` を追加
- prerelease modeを設定
- GitHub Release PRを作るworkflowを追加
- npm provenanceを有効化
- publish前に `npm pack` とtarball smokeを実行

### 7.3 Node.jsの扱い

pnpm 11を採用するため、リポジトリ開発Nodeを22.18以上へ引き上げる。

公開packageの `engines.node` は `>=22` とし、Node 22 consumer smokeを継続する。

### 7.4 完了条件

- YarnとLernaへの参照がない
- `pnpm install --frozen-lockfile` が再現可能
- build/test/e2eの成果物が移行前と同一
- `npm pack` のファイル一覧とexportsが意図せず変化していない
- package tarballがNode 22で動作する

## 8. Phase 3 — Vite+・Vitest導入

### 8.1 目的

Vite+をworkspace task orchestration、開発runtime、CIの統一入口として導入する。test runnerは独立PRでVitestへ移行し、lint、format、packを一括置換しない。

計画策定時点のVite+は0.2系列のBetaであり、最新patchを完全固定して導入する。Vite+のAPIをStoryFreezeのruntimeコードへ依存させず、削除可能なtooling layerとして扱う。

### 8.2 重要な方針

**最初の導入で `vp migrate` を実行しない。**

`vp migrate` はlint、format、test、package scripts等をまとめて書き換えるため、責務ごとの差分と検証結果を分離できない。

手動で最小導入し、各責務を別PRへ分離する。

### 8.3 実装項目

#### PR-300: Vite+最小導入

PR-301とともにPR #16で完了した。

- `vite-plus` をroot devDependencyへ完全固定で追加
- root `vite.config.ts` を追加
- project開発NodeをVite+対応versionへ固定
- package-levelの `tsc` build scriptは維持
- root build/test taskを `vp run` でorchestrationする
- contributor向け入口は従来どおり `pnpm build` と `pnpm test` にする
- Vite+ global CLIを必須にしない
- Vite+ task cacheのoutput globを明示する

#### PR-301: CI統合

PR-300とともにPR #16で完了した。

- GitHub Actionsで `voidzero-dev/setup-vp` を使用
- actionはtagではなくcommit SHAへ固定
- Node 22.18 / 24.11系で通常CIを実行
- dependency cacheとVite task cacheを分離
- Node 22 consumer smokeは従来どおりnpmで実行

#### PR-302: Test runner移行（独立判断）

PR #17でJestからVite+に統合されたVitestへ移行した。

移行時は13 test files、93 tests（1 skipped）を維持した。各testのimportを `vite-plus/test` へ変更し、Jest、ts-jest、Jest型依存を削除した。

#### PR-303: Library pack評価（見送り）

TypeScript buildの `vp pack` 移行は採用せず、`tsc --p tsconfig.build.json` を維持する。

移行条件:

- ESM output、declaration、source mapが同一契約
- shebangが保持される
- package exports snapshotが同一
- tarball sizeの異常増加がない
- CLI cold startが悪化しない

現行の `tsc` buildは上記契約を満たしており、tooling置換だけを目的とした再実装に利点がない。PR-303は未完タスクとして残さない。

### 8.4 Vite+とlint/formatの境界

Phase 3の最小導入時点では、lintとformatを変更しない。

- PR-300/301では既存ESLintとPrettierを維持する
- Vitest移行はPR-302へ分離する
- Oxlint/Oxfmt移行はPhase 4へ分離する
- library buildは引き続きpackage-localの `tsc` を正とする

### 8.5 Tooling境界

- StoryFreezeのruntime sourceから `vite-plus` をimportしない
- 公開packageのbuildはpackage-localの `tsc` で完結させる
- Vite+固有のtask、test、lint、format設定はrootのtooling layerへ限定する
- Vite+を置換する場合も公開packageのruntime、exports、tarball契約を変更しない

### 8.6 完了条件

- Vite+経由のbuild/testが既存結果を維持する
- task cacheが生成物を誤って再利用しない
- CIとローカルでversionが固定されている
- Vitest移行前後でtest countと主要assertionが維持されている
- Jest dependencyとJest global型が残っていない
- package buildは `tsc` のまま維持されている

## 9. Phase 4 — Oxlint・Oxfmt導入

### 9.1 目的

Vite+に統合されたOxlintとOxfmtを、lintとsource formattingのsingle source of truthとする。既存ルールとformat scopeを維持し、tooling移行を大規模なsource書き換えにしない。

### 9.2 Vite+との責務分離

StoryFreezeでは次を採用する。

| 責務                              | 正とするツール        |
| --------------------------------- | --------------------- |
| Workspace task / cache / CI entry | Vite+                 |
| TypeScript build                  | package-localの `tsc` |
| Unit test                         | Vite+ test（Vitest）  |
| Lint                              | `vp lint`（Oxlint）   |
| Source formatting                 | `vp fmt`（Oxfmt）     |

ESLint、Prettier、Oxlint、Oxfmtを同じファイルへ二重適用しない。

### 9.3 実装項目

#### PR-400: Oxlint移行

PR #19で完了した。

- ESLint、TypeScript ESLint、legacy configを削除
- rootの `pnpm lint` を `vp lint` へ変更
- 対象を公開packageのsourceに限定
- 既存のbehavioral rulesを維持
- lint autofixによる無関係なsource変更を含めない

#### PR-401: Oxfmt移行

PR #20で完了した。

- Prettierとpretty-quickを削除
- `.prettierrc.yml` と `.prettierignore` を削除
- rootのformat scriptsを `vp fmt`、pre-commit hookを `vp staged` 経由のOxfmtへ変更
- quote、semi、trailing comma、print widthなどの既存styleを維持
- 初回移行で全sourceの機械的再formatを行わない

旧PR-402として予定していた全sourceのmechanical formattingは実施しない。必要になった場合のみ、ロジック変更を含まない独立PRとする。

#### PR-403: CI gate

次を既存のUnit test workflowで実行する。

```text
pnpm baseline:verify
pnpm format:check
pnpm lint
pnpm build
pnpm test
pnpm package:smoke
```

`pnpm lint` 以外は導入済みである。Phase 4の残作業は、Node 22のjobへ `pnpm lint` を追加する独立した最小CI PRだけとする。

### 9.4 更新ポリシー

- Vite+更新時はOxlint/Oxfmtのrule、diagnostic、format差分を確認する
- rule変更とformatter変更を同じdependency updateへ混在させない
- autofixや全量formatをdependency updateへ含めない
- Vite+本体は公開から24時間経過後に完全固定versionで更新する

### 9.5 完了条件

- ESLint、Prettierとその設定がactive toolingに残っていない
- lintの正がOxlint、formatの正がOxfmtに統一されている
- formatterのみの差分とロジック差分が分離されている
- `pnpm format:check` と `pnpm lint` がCI gateになっている
- dependency update後もtracked filesが意図せず変更されない

## 10. Phase 5 — Playwright移行

### 10.1 目的

Puppeteer依存を段階的にPlaywrightへ移す。最初は実行モデルを変えず、ドライバ差と並列モデル差を分離して測定する。

### 10.2 移行順序

```text
5A. Browser backend境界を導入
5B. Playwrightを1 worker = 1 browserで追加
5C. Puppeteer / Playwright差分テスト
5D. Playwrightをデフォルト化
5E. 1 browser + N BrowserContextへ最適化
5F. Puppeteerを削除
```

### 10.3 5A — Browser backend抽象化

#### PR-500: Core interface

次と同等の責務境界を導入する。

```ts
interface BrowserBackend {
  readonly name: string;
  devices(): readonly BrowserDeviceDescriptor[];
  launch(options: BrowserRuntimeOptions): Promise<BrowserInstance>;
}

interface BrowserInstance {
  readonly executablePath: string;
  newSession(): Promise<BrowserSession>;
  close(): Promise<void>;
}

interface BrowserSession {
  page: CapturePage;
  close(): Promise<void>;
}

interface CapturePage {
  // navigation / preview state / exposed functions / styles
  // viewport / element input / pointer reset
  // request and console subscriptions / metrics
  // PNG screenshot / Chromium trace
}
```

最初の境界は上記4 interfaceと、viewport、request、console、metrics、screenshot、deviceの中立DTOに限定する。render stability、resource tracking、screenshot、trace、device、executable resolutionを独立classへ分割せず、現在のライフサイクルに沿ったpage/backend capabilityとして扱う。

規則:

- Coreと公開APIへPuppeteer/Playwright型を出さない
- raw pageを公開しない
- 既存の `--puppeteer-launch-config` はPuppeteer互換入力として維持する
- 公開API、CLI、エラー、process topologyをPR-500では変更しない

#### PR-501: Puppeteer adapter

既存挙動をPuppeteer adapterで再現する。

この時点ではdefaultも性能も変えない。characterization testがすべて通ることを確認する。

### 10.4 5B — Playwright process-parity backend

#### PR-510: Playwright adapter

最初のPlaywright実装は、現行と同じ `1 worker = 1 browser process` とする。

CLI:

```bash
storyfreeze <url> --browser-backend=puppeteer
storyfreeze <url> --browser-backend=playwright
```

初期defaultはPuppeteer。

実装項目:

- Chromium launch
- page navigation
- viewport/emulation
- hover/focus/click
- console forwarding
- request tracking
- screenshot
- browser close/crash handling
- retry/timeout
- CDP session

#### [Browser distribution ADR](docs/adr/009-playwright-browser-distribution.md)

PR-510着手前にブラウザ配布方針をADRで決める。

候補:

1. `playwright-core` + 利用者がChrome/Chromiumを指定
2. `playwright` + `playwright install chromium`
3. `@playwright/browser-chromium` によりinstall時にChromium取得

推奨初期案:

- runtime APIは `playwright-core`
- `--chromium-path` とChrome channelを維持
- Playwright managed Chromiumを検出可能にする
- `storyfreeze doctor` で利用可能なbrowserとversionを表示
- browserを同梱するかはpackage size、CI再現性、proxy環境を測定して決定

#### PR-511: Compatibility layer

次を明示的に処理する。

- `page.metrics()` 相当はChromium CDP `Performance.getMetrics`
- `captureBeyondViewport` はCDP互換経路または非推奨化方針
- CPU traceは同時実行制約を考慮
- device descriptor名をStoryFreezeのregistryへ移す
- `puppeteerLaunchConfig` は `browserLaunchOptions` のlegacy aliasとして警告付き受理
- `chromiumPath` / `chromiumChannel` は維持

`networkidle` だけを撮影準備完了条件にしない。

決定:

- `captureBeyondViewport` は両backendでdefault `true`を維持し、Chromium CDP経路でPuppeteer 9のfull-page、clip、viewport復元契約を再現する
- metricsは両backendとも `Performance.getMetrics` の `Nodes`、`RecalcStyleCount`、`LayoutCount`を使う
- traceは既存のChromium CPU trace JSONとcategoryを維持し、1 browser processにつき同時1 traceに制限する。現在の1 worker = 1 browserでは4並列を維持する
- device名とviewportはPuppeteer 9互換の77件をStoryFreeze registryとして固定し、backend更新で暗黙に増減させない
- canonical launch optionを `browserLaunchOptions` とし、`puppeteerLaunchConfig` は警告付きaliasとして維持する

判断記録:

- [ADR-010: `captureBeyondViewport` compatibility](docs/adr/010-capture-beyond-viewport-compatibility.md)
- [ADR-011: Chromium CPU trace and parallelism](docs/adr/011-cpu-trace-parallelism.md)

### 10.5 5C — Differential test

#### PR-520: 同一条件比較

比較条件を固定する。

- 同一OS image
- 同一font
- 同一Chromium executable
- 同一起動引数
- 同一viewport/device scale
- 同一fixture
- 同一parallel数
- 同一PNG encoder条件

判定項目:

- story件数
- PNG件数とpath
- pixel diff
- capture失敗率
- retry率
- timeout率
- browser crash率
- wall time
- capture request単位p50/p95
- peak RSSまたはcgroup memory
- CPU time
- child process数

CI環境は現行のbrowser明示installと、version固定したPlaywright公式containerをA/B比較する。containerは再現性を目的とし、image pullを含むwall timeとmemoryの改善を確認できた場合だけ標準CIへ採用する。

画像差は、変更理由を分類する。

```text
EXPECTED_BROWSER_DIFF
EXPECTED_DRIVER_DIFF
REGRESSION_LAYOUT
REGRESSION_TIMING
REGRESSION_OPTION_MAPPING
UNKNOWN
```

unknown差分をbaseline更新で隠さない。

#### PR-521/522: render wait安定化

PR-521でcapture phase、idle timeout、metrics、resource、出力path、close timingを内部診断JSONとして記録する。通常利用時は診断callbackを公開せず、runtimeの待機挙動を変えない。

PR-522でpreviewとNode側の`requestIdleCallback({ timeout: 3000 })`を、font、image decode、double `requestAnimationFrame`、250ms paint fallbackからなるvisual commit待機へ置換する。Node側はsimple mode、viewport変更、interaction後だけ実行し、managed modeの重複待機を避ける。

同一Chromium、fixture、`parallel=4`で各版40 measured runs/backendを比較した結果:

- Playwright idle timeout: 77 → 0
- 3秒以上のPlaywright capture request: 51 → 0
- Playwright wall p50: 8,868ms → 5,821ms
- Playwright wall p95: 17,351ms → 6,031ms
- Playwright capture-request p95: 4,437ms → 1,734ms
- candidateのPlaywright/Puppeteer比: wall p50 1.011、wall p95 0.990、RSS 0.798、CPU 0.863
- failure、retry、timeout、crash、PNG mismatch、visual commit timeoutは0

この結果だけでdefault backendは変更しない。不要なreset navigation、MetricsWatcher/ResourceWatcherのquiet windowとwall timeout、Playwright recoveryはPR #36〜#38として分離して完了した。

PR #38 merge後の`master`を同じChromium、fixture、`parallel=4`で再計測し、visual-commit版をbaselineとして各40 measured runs/backendを比較した結果:

- Puppeteer wall p50: 5,755ms → 5,445ms、wall p95: 6,089ms → 5,736ms
- Puppeteer capture-request p95: 1,988ms → 1,770ms、peak RSS: 4,644,823,040 bytes → 4,585,390,080 bytes
- Playwright wall p50: 5,821ms → 5,222ms、wall p95: 6,031ms → 5,813ms
- Playwright capture-request p50: 1,311ms → 1,083ms、p95: 1,734ms → 1,540ms
- candidateのPlaywright/Puppeteer比: wall p50 0.959、wall p95 1.013、RSS 0.797、CPU 0.876
- failure、retry、timeout、crash、PNG mismatch、3秒tail、visual commit timeoutは両backendとも0

両backendでwall p50/p95が改善し、Playwrightはdefault化の記録済み目標をすべて満たした。BrowserContext共有は必要性とprocess-parityへの影響を別途評価する。

### 10.6 5D — Playwright default化

Playwrightをdefaultにする条件:

- 全release-blocker fixtureが通る
- Puppeteer比でcapture成功率が悪化しない
- retry/timeout率が悪化しない
- 画像差の全件に説明がある
- process-parity条件でp95 wall timeが10%以上悪化しない
- browser lifecycle testが通る
- migration guideがある

CLI defaultを変更する。

```text
--browser-backend=playwright  # default
--browser-backend=puppeteer   # temporary fallback
```

### 10.7 5E — BrowserContext最適化

ドライバ移行後に実行モデルを変更する。

#### PR-530: Context isolation mode

```bash
storyfreeze <url> --browser-isolation=context
storyfreeze <url> --browser-isolation=process
```

構成:

```text
1 Chromium process
├─ BrowserContext + Page: worker 0
├─ BrowserContext + Page: worker 1
├─ BrowserContext + Page: worker 2
└─ BrowserContext + Page: worker 3
```

実装契約:

- workerごとに独立Context
- cookie/storage/cache/service workerの漏洩を防ぐ
- `EmulationProfile` をkeyにContextを再利用
- `isMobile`、`hasTouch`、deviceScaleFactor等の変更時に再生成
- context close失敗時にbrowser全体を汚染しない
- browser crash時に実行中jobをqueueへ戻す
- retryは新しいContextで行う

CPU traceがbrowser単位で競合する場合、`--trace` 時はprocess modeまたは直列化へ自動切替する。

#### 性能gate

Context modeをdefaultにする目標:

- process mode比でpeak memoryを20%以上削減
- wall timeを悪化させない
- p95 capture request timeを5%以上悪化させない
- failure/retry率を悪化させない
- browser process数を削減

目標を満たさない場合、Playwrightへ移行済みでもprocess modeをdefaultのままにする。

### 10.8 5F — Puppeteer削除

#### PR-540: Legacy removal

1.0直前に実施する。

- Puppeteer adapter削除
- `puppeteer` / `puppeteer-core` dependency削除
- `--browser-backend=puppeteer` 削除
- `puppeteerLaunchConfig` alias削除
- Puppeteer型・device data削除
- migration guide最終化
- dependency treeにPuppeteerがないことを検証

## 11. Render stability契約

Playwright移行の成否はscreenshot APIより、撮影可能状態の判定に依存する。

初期版は現在の挙動を互換実装し、後から改善する。

### 11.1 必須待機要素

- StoryFreeze preview handshake
- `waitFor`
- 明示delay
- in-flight requestの収束
- `document.fonts.ready`
- `<img>` のload/decode
- requestAnimationFrameの連続安定
- MutationObserver quiet window
- Chromium metrics compatibility mode

### 11.2 禁止事項

- `networkidle` のみをready条件にしない
- 固定sleepだけで非同期render完了とみなさない
- URL単位のrequest完了cacheを使わない
- timeout時に診断情報なしで再試行しない

### 11.3 診断出力

timeout時は最低限次を出す。

- story ID
- URL
- backend / browser version
- active requests
- fonts/images status
- preview protocol state
- metrics sample
- retry回数
- screenshot option

## 12. テストマトリクス

### 12.1 Release blocker

| 軸               | 必須                                  |
| ---------------- | ------------------------------------- |
| Storybook        | 10.x固定version + 最新10.x smoke      |
| Framework        | React + Vite                          |
| Storybook形態    | static build再利用                    |
| Mode             | simple / managed                      |
| OS               | Linux固定image                        |
| Node consumer    | 22                                    |
| Node development | 22.18 / 24.11以上                     |
| Browser          | runner stable（5A）/ 同一固定版（5C） |
| Output           | PNG、path、manifest                   |

### 12.2 Smoke

- Vue 3 + Vite
- Web Components + Vite
- macOS
- Windows
- local Chrome stable channel
- explicit chromium path
- remote/hosted Storybook

### 12.3 Package smoke

各Phaseで必ず次を行う。

1. `npm pack`
2. 空のfixtureへtarballをinstall
3. `storyfreeze --version`
4. addonをStorybook configへ追加
5. static Storybookをbuild
6. CLIで撮影
7. 生成PNGを検証
8. package外のundeclared dependencyへ依存していないことを検証

## 13. CI構成

推奨job:

```text
lint
unit-test
build
package-smoke-node22
storybook10-e2e-puppeteer
storybook10-e2e-playwright
browser-lifecycle
visual-differential
performance-nightly
publish-dry-run
```

Phaseに応じ、存在しないbackendのjobは追加しない。

performance benchmarkは通常PRのblocking jobと、nightlyの詳細jobに分ける。

通常PR:

- 小fixture
- 3回実行中央値
- 重大な回帰のみblock

nightly:

- 大fixture
- 複数parallel値
- p50/p95
- memory、CPU、process数
- artifactとしてJSONとtraceを保存

## 14. PR分割一覧

| PR  | 内容                                | 主な変更対象      |
| --- | ----------------------------------- | ----------------- |
| 000 | Fork、由来、project metadata        | docs/repository   |
| 001 | Baselineとcharacterization tests    | tests/fixtures    |
| 002 | lifecycle/resource watcher修正      | runtime           |
| 100 | StoryFreezeへ改名                   | package/CLI/docs  |
| 101 | ESM-only化                          | build/exports     |
| 102 | Storybook 10 fixtures               | examples/e2e      |
| 103 | `index.json`列挙                    | storybook/core    |
| 104 | Preview protocol/navigation         | addon/runtime     |
| 105 | `storycrawler`削除                  | runtime/deps      |
| 106 | Storybook 10 addon packaging        | package metadata  |
| 107 | Storybook 10 E2E gateとstatic再利用 | CI                |
| 200 | pnpm workspace                      | package manager   |
| 201 | Lerna削除                           | scripts           |
| 202 | build script approval               | install/CI        |
| 203 | Changesets/release                  | publish           |
| 300 | Vite+最小導入                       | tooling           |
| 301 | Vite+ CI（300と統合）               | CI                |
| 302 | Jest→Vitest                         | tests             |
| 303 | `vp pack`評価・見送り               | build             |
| 400 | Oxlint移行                          | lint              |
| 401 | Oxfmt移行                           | format            |
| 403 | lint CI gate                        | CI                |
| 499 | browser lifecycle hardening         | runtime           |
| 500 | Browser interfaces                  | architecture      |
| 501 | Puppeteer adapter                   | browser           |
| 510 | Playwright process backend          | browser           |
| 511 | CDP/option compatibility            | browser           |
| 520 | differential test                   | tests/benchmark   |
| 521 | capture wait diagnostics            | runtime/benchmark |
| 522 | visual commit wait                  | runtime           |
| 530 | BrowserContext mode                 | performance       |
| 540 | Puppeteer removal                   | dependencies/API  |

## 15. 同じPRへ入れてはいけない変更

- Storybook 10対応とPlaywright移行
- Storybook 10対応とpnpm移行
- pnpm移行とVite+導入
- Vite+ task orchestration導入とtest/lint/format移行
- Browser backend変更とBrowserContext最適化
- Chromium version更新とdriver変更
- formatter全量適用とロジック変更
- package renameと出力命名規則変更
- snapshot baseline更新と原因不明の画像差

## 16. ADR一覧

少なくとも次をADRとして残す。

| ADR                                                              | 判断内容                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| ADR-001                                                          | StoryFreezeの独立性、名称、互換API                       |
| ADR-002                                                          | 開発Nodeとconsumer Nodeの分離                            |
| ADR-003                                                          | Storybook story indexの取得経路                          |
| ADR-004                                                          | Preview protocol v1                                      |
| ADR-005                                                          | `storycrawler`を廃止する理由                             |
| ADR-006                                                          | pnpm 11とworkspace設計                                   |
| ADR-007                                                          | Vite+をtooling layerに限定しbuildは `tsc` を維持する理由 |
| ADR-008                                                          | Oxlint/Oxfmtを正としESLint/Prettierを撤去する判断        |
| [ADR-009](docs/adr/009-playwright-browser-distribution.md)       | Playwright browser配布方針                               |
| [ADR-010](docs/adr/010-capture-beyond-viewport-compatibility.md) | `captureBeyondViewport`互換方針                          |
| [ADR-011](docs/adr/011-cpu-trace-parallelism.md)                 | CPU traceとparallelism                                   |
| ADR-012                                                          | process/context isolationのdefault                       |

## 17. IssueラベルとMilestone

推奨Milestone:

```text
M0 — Fork & Baseline
M1 — Storybook 10
M2 — pnpm
M3 — Vite+ & Vitest
M4 — Oxlint & Oxfmt
M5 — Playwright Parity
M6 — Playwright Performance
M7 — 1.0
```

推奨label:

```text
area:storybook
area:browser
area:tooling
area:release
area:stability
area:performance
area:compatibility
kind:breaking
kind:refactor
kind:test
status:blocked
status:needs-adr
```

## 18. 最初に着手するIssue

最初のIssueは次の順に作成する。

1. Fork attributionとREADMEの独立性表記
2. 現行Storycapture 9のbaseline固定
3. 主要CLI・ScreenshotOptionsのcharacterization tests
4. browser lifecycleとResourceWatcherの修正
5. StoryFreeze package/CLI rename
6. Storybook 10 React/Vite failing fixture
7. ESM-only package exports
8. `index.json` StoryIndexProvider
9. Preview protocol v1
10. `storycrawler` dependency removal
11. Storybook 10 tarball E2E
12. `0.1.0-alpha.0` publish dry-run

Phase 1完了までは、pnpm、Vite+、lint/format tooling、Playwright関連Issueを「設計済み・未着手」とし、実装PRを開始しない。

## 19. 1.0のDefinition of Done

StoryFreeze 1.0は、次をすべて満たした場合のみ公開する。

- Storybook 10対応
- ESM-only
- Node 22 consumer smoke
- pnpm workspace
- Vite+によるtask/CI統合
- Vitest、Oxlint、Oxfmtによるtest/lint/format gate
- Playwright default
- Puppeteerと`storycrawler`へのruntime dependencyなし
- simple / managed mode互換
- 既存の主要ScreenshotOptions互換
- BrowserContext modeの安定性検証済み
- package tarball E2E
- browser lifecycle leakなし
- migration guide完成
- API reference完成
- 性能benchmark公開
- セキュリティ報告窓口あり
- npm provenance付きpublish

## 20. 参考資料

- Base repository: https://github.com/huuyafwww/storycapture
- Storybook 10 migration: https://storybook.js.org/docs/releases/migration-guide
- Storybook 10 addon migration: https://storybook.js.org/docs/addons/addon-migration-guide
- pnpm workspace: https://pnpm.io/workspaces
- pnpm installation/version compatibility: https://pnpm.io/installation
- Vite+ guide: https://viteplus.dev/guide/
- Vite+ migration: https://viteplus.dev/guide/migrate
- Vite+ check: https://viteplus.dev/guide/check
- Vite+ monorepo: https://viteplus.dev/guide/monorepo
- Playwright library: https://playwright.dev/docs/library
- Playwright browser contexts: https://playwright.dev/docs/browser-contexts
