[English](#english) | [Tiếng Việt](#tieng-viet)

---

# RouterSync

[![CI](https://github.com/CThawngs/Router-Sync/actions/workflows/ci.yml/badge.svg)](https://github.com/CThawngs/Router-Sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=22.12](https://img.shields.io/badge/Node-%3E%3D22.12-3fa66f.svg)](https://nodejs.org)
[![Status: Pre-Alpha](https://img.shields.io/badge/Status-Pre--alpha-orange.svg)](CHANGELOG.md)

> Keeps model lists and combos in sync across LLM routers, agent harnesses and
> providers. Local-first, human-approved, zero inference tokens.

> [!WARNING]
> **`0.1.0`.** The read-only surface is the stable part:
> scanning, planning, ranking preview, verification and the daemon. Every
> write command refuses to run without an interactive TTY and the confirmation
> word it prints in `--help`, so a pipe or a CI job cannot approve a write.

---

<a id="english"></a>

## English

### Overview

RouterSync is a local command-line tool and MCP server that keeps the model
lists of LLM routers (9Router, OmniRoute) in sync with the combo definitions
you want, and with the agent harnesses that consume them (OpenCode, Claude
Code, Hermes Agent, or any MCP client).

It reads a router database in read-only mode, asks each provider for its
public model list with a plain `GET /models`, compares the result with the
current combo, and produces a plan. Nothing is written to a router until a
human types the confirmation word on a terminal.

### Purpose

**Goal.** Stop hand-editing combo step lists in several routers at once, and
make every change reviewable before it happens.

**Benefits.**

- One declarative file (`config.yaml`) describes the routers and the combos (a legacy `routersync.yaml` in the working directory is also accepted by the loader). Each router entry in `config.yaml` must use a distinct adapter (e.g. one `9router` and one `omniroute`); multiple routers sharing the same adapter are rejected with a clear error.
- A plan shows exactly which steps are added, moved or dropped before anything
  is written.
- Every write is preceded by a snapshot and followed by a read-back.
- Model discovery costs zero inference tokens: only model listings are fetched.

### Main Features

- **Read-only scan** - reads the router database and the provider model lists.
- **Deterministic plan** - the same inputs always produce the same plan hash.
- **Ranking preview** - shows the new combo order without touching the router.
- **Verification** - labels every model across three layers (provider list,
  external catalogue, upstream notice).
- **Zero-token tracking** - `tick` watches the catalogues and writes to the
  inbox; it never calls a paid endpoint.
- **MCP server** - 24 read-only tools, no write tool.
- **Daemon and web UI** - a local read-only dashboard.

#### How it works

```text
  scan  ->  compare  ->  plan  ->  confirm  ->  backup  ->  narrow write  ->  read-back  ->  undo
   |          |           |          |            |             |                |           |
 GET /models  |      dry-run diff   type the    snapshot      only the        re-read    restore the
 with your    |      + plan hash    word on     the router   steps in        the router   previous
 own key      |                    a TTY       database     the plan        database    step list
```

#### Safety model

Only claims that the test suite proves are listed here.

| Rule | What it means |
|---|---|
| Read-only by default | `scan`, `plan`, `rank`, `verify`, `tick`, `daemon` never write to a router. |
| Human confirmation | `sync --apply`, `undo --apply`, `rank --apply` and `rollback --write` refuse to run when stdin is not a TTY, and then require the confirmation word typed by hand. |
| Backup before a write | A write snapshots the router rows it is about to change before the transaction. |
| Read-back after a write | After a write the router is read again through the same path it serves from. |
| Bounded undo | `undo` restores the step list of the newest sync backup; it does not invent a rollback of an unrelated change. |
| Zero inference tokens | `tick` and the scanners call `GET /models` only. They never call a chat or completion endpoint. |
| Secrets stay local | API keys are read into memory, never printed, never written to a plan or a log. |

#### Install

Requirements on every platform: **Node.js >= 22.12** and **pnpm >= 10**.
The SQLite driver (`better-sqlite3`) ships a prebuilt binary for macOS
(Intel and Apple Silicon), Linux (x64 and arm64) and Windows inside the npm
package, so **no C++ compiler and no manual build step is needed**. The
repository pins the package manager in `packageManager` and the Node version
in `.nvmrc`, so `corepack enable pnpm` picks the right one.

> **Note about the SQLite driver.** `pnpm install` prints an "Ignored build
> scripts: better-sqlite3" warning on purpose: the package ships the compiled
> binary for every supported platform, and building it from source would
> require a C++ toolchain. The warning is harmless.

**Windows (PowerShell)**

```powershell
node --version          # must be >= v22.12.0
corepack enable pnpm    # or: npm install -g pnpm@10
git clone https://github.com/CThawngs/Router-Sync.git
cd Router-Sync
pnpm install --frozen-lockfile
pnpm build
New-Item -ItemType Directory -Force "$env:APPDATA\routersync" | Out-Null
Copy-Item ranking.example.yaml "$env:APPDATA\routersync\ranking.yaml"
node packages/cli/dist/index.js init     # create default config.yaml configuration
node packages/cli/dist/index.js scan     # first read-only command
```

**macOS (Terminal)**

```bash
node --version          # must be >= v22.12.0
corepack enable pnpm    # or: npm install -g pnpm@10
git clone https://github.com/CThawngs/Router-Sync.git
cd Router-Sync
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.config/routersync && cp ranking.example.yaml ~/.config/routersync/ranking.yaml
node packages/cli/dist/index.js init     # create default config.yaml configuration
node packages/cli/dist/index.js scan     # first read-only command
```

**Linux (Terminal)**

```bash
node --version          # must be >= v22.12.0
corepack enable pnpm    # or: npm install -g pnpm@10
git clone https://github.com/CThawngs/Router-Sync.git
cd Router-Sync
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.config/routersync && cp ranking.example.yaml ~/.config/routersync/ranking.yaml
node packages/cli/dist/index.js init     # create default config.yaml configuration
node packages/cli/dist/index.js scan     # first read-only command
```

> **Running commands via `pnpm routersync`:** You can invoke any command using
> `pnpm routersync <command>` (for example `pnpm routersync doctor`) or via
> `node packages/cli/dist/index.js <command>`.
> *Note:* Running `pnpm doctor` triggers pnpm's own built-in environment
> diagnosis tool (which outputs nothing for RouterSync); always use
> `pnpm routersync doctor`.

**Example output:** The output depends on which router instances are currently running. For example, when OmniRoute is stopped and 9Router is running locally without a client key configured:

```text
[routersync] Scanned 2 router(s) from <config-path>:
  ✗ [omni] (omniroute) - Status: down (...) | Read-Back: db-only (degraded) | Combos: 0 | Models: 0
      Read-Back Info: Router API unreachable (fetch failed) - serving path unconfirmed, degraded to db-only
      Detail: fetch failed
  ✓ [nine] (9router) - Status: ok (...) | Read-Back: db-only (degraded) | Combos: 0 | Models: 0
      Read-Back Info: No client key configured. 9Router API requires browser session or NINEROUTER_CLIENT_KEY for /v1/models.
```

**Default router database locations:**

| Router | Platform / Environment | Default Database Path | Override Environment Variable |
|---|---|---|---|
| 9Router | Windows | `%APPDATA%\9router\db\data.sqlite` | `ROUTERSYNC_9ROUTER_DB` (or `${DATA_DIR}/db/data.sqlite` if `DATA_DIR` is set) |
| 9Router | macOS / Linux | `~/.9router/db/data.sqlite` | `ROUTERSYNC_9ROUTER_DB` (or `${DATA_DIR}/db/data.sqlite` if `DATA_DIR` is set) |
| OmniRoute | All platforms | `~/.omniroute/storage.sqlite` | `ROUTERSYNC_OMNIROUTE_DB` |

*Note: 9Router database resolution on macOS/Linux is documented from installation references and source code inspection, but has not yet been run on physical macOS/Linux hardware by the author.*

#### Set up with an AI agent

If you are handing this repo to an AI agent (Claude Code, OpenCode, Codex,
Gemini CLI, Antigravity), paste this single instruction:

> "Clone `<repo URL>`, read `AGENTS.md`, set up RouterSync, and ask me before
> any decision."

The agent will run `pnpm routersync doctor --json`, follow `nextSteps`, and only
propose read-only actions. Every write command (`sync --apply`, `undo --apply`,
`rank --apply`, `rollback --write`) must be typed by you in your own terminal — the agent never
types the confirmation word for you.

*Note: `routersync <command>` in this document is run via `pnpm routersync <command>`.*

#### CLI

| Command | What it does | Writes to a router? |
|---|---|---|
| `routersync init` | Write a starter `config.yaml`. | No |
| `routersync scan` | Read the router databases and the provider lists. | No |
| `routersync plan` | Compute the plan and print the diff. | No |
| `routersync status` | Show router health and read-back level. | No |
| `routersync doctor` | Diagnose the configuration. | No |
| `routersync verify` | Label every model across L1/L2/L3. | No |
| `routersync tick` | One zero-token catalogue and inbox pass. | No |
| `routersync rank` | Preview the new combo order. | No (unless `--apply`) |
| `routersync sync` | Plan and, with `--apply`, write. | Only with `--apply` + TTY + the word |
| `routersync undo` | Restore the step list of the newest sync backup. | Only with `--apply` + TTY + the word |
| `routersync rollback [id]` | Restore a persisted snapshot. | Only with `--write` + TTY + the word |
| `routersync daemon` | Run the local read-only daemon. | No |
| `routersync inbox list\|ack\|snooze` | Work with the notification inbox. | No |
| `routersync mcp install` | Print the MCP client configuration. | No |

#### MCP client configuration

RouterSync ships a read-only MCP server with 24 tools. Paste this into an MCP
client (the path is the one you installed from):

```json
{
  "mcpServers": {
    "routersync": {
      "command": "node",
      "args": ["/absolute/path/to/routersync/packages/mcp-server/dist/index.js"],
      "env": {
        "ROUTERSYNC_STATE_DIR": "/absolute/path/to/state"
      }
    }
  }
}
```

#### Scheduling `tick`

`tick` reads model lists only, so a scheduled run costs **0 tokens**. Ready to
use samples live in [`examples/schedule/`](examples/schedule/):

| Platform | File |
|---|---|
| Windows Task Scheduler | `examples/schedule/windows-task-scheduler.xml` |
| macOS launchd | `examples/schedule/macos-launchd.plist` |
| Linux systemd timer | `examples/schedule/linux-systemd-timer.service` + `.timer` |
| Linux cron | `examples/schedule/linux-cron.txt` |

#### Troubleshooting

| Symptom | What to do |
|---|---|
| `Cannot open the router database at "..."` | The router database was not found. Copy the printed path into `config.yaml` under `routers[].db.path`, or set `ROUTERSYNC_9ROUTER_DB` / `ROUTERSYNC_OMNIROUTE_DB`. |
| `Configuration file not found at: ...` | Run `routersync init` or point `ROUTERSYNC_CONFIG` at your file. |
| `Write Execution Blocked ... stdin is not a TTY` | A write command needs a human. Run it in an interactive terminal. |
| `No ranking policy file at ...` | Copy `ranking.example.yaml` to the printed location. The tool still runs read-only, but every write path refuses while the file is missing. |
| `Failed to load better-sqlite3 native addon` | Rebuild the native module: `pnpm rebuild better-sqlite3`. |
| `SHRINK-GUARD-BLOCKED` in `status.json` or `PROVIDER` output | A provider model list shrank by more than the threshold (default 30%). The old catalog is preserved. Review the official provider model list to confirm genuine removals vs provider outage; if genuine, a human operator (not an agent) may reset the baseline by removing that provider's entry from `tick-catalog.json` or rerun with `--max-shrink-ratio`. |
| A provider shows `AUTH_ERROR` | The key in the router database is expired or invalid. RouterSync never prints the key. |

#### Documentation map

| Document | Content |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | First-time setup |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) / [`docs/WORKFLOW.vi.md`](docs/WORKFLOW.vi.md) | The daily workflow |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What is planned and what is known to be missing |
| [`docs/compat-matrix.md`](docs/compat-matrix.md) | Platform and feature matrix |
| [`docs/adapters/`](docs/adapters/) | Per-router and per-harness notes |
| [`docs/adr/`](docs/adr/) | Architecture decision records |
| [`docs/runbook/`](docs/runbook/) | Runbooks for the first apply |
| [`docs/security/`](docs/security/) | Daemon threat model |
| [`examples/schedule/`](examples/schedule/) | Ready-to-use schedule samples |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute |

### Conclusion

RouterSync is deliberately conservative: it reads, it plans, it asks, and only
then does it write - and it refuses to write at all when nobody is watching.
If you want to try it, run `routersync scan` first. It changes nothing.

### Disclaimer

RouterSync is not affiliated with, endorsed by or sponsored by 9Router,
OmniRoute, OpenAI, Google, Anthropic or any other provider. Product names and
logos belong to their respective owners and are used only to describe what
this tool talks to.

The software is provided "AS IS", without warranty of any kind, under the
[MIT licence](LICENSE).

You are responsible for every write to your own router. RouterSync asks for
confirmation before it writes, but the consequences of a write are yours.

The tool calls `GET /models` with **your own API key** - the key that is
already stored in your router database - and reads public catalogue pages
(OpenRouter, models.dev, LiteLLM and provider deprecation notices). It never
calls a chat or completion endpoint, so model discovery costs 0 tokens.

---

<a id="tieng-viet"></a>

## Tiếng Việt

### Tổng quan

RouterSync là công cụ dòng lệnh và máy chủ MCP chạy cục bộ, giữ danh sách
model của các router LLM (9Router, OmniRoute) khớp với phần định nghĩa
combo bạn muốn dùng, và khớp với các agent harness tiêu thụ chúng
(OpenCode, Claude Code, Hermes Agent, hoặc bất kỳ ứng dụng khách MCP nào).

Công cụ đọc database của router ở chế độ chỉ đọc, hỏi từng nhà cung cấp
danh sách model công khai bằng một lệnh `GET /models`, so sánh kết quả với
combo hiện tại, rồi lập kế hoạch. Không có gì được ghi vào router cho tới
khi một người gõ từ xác nhận trên terminal.

### Mục đích

**Mục tiêu.** Không phải sửa tay danh sách bước combo trong nhiều router,
và mọi thay đổi đều xem lại được trước khi xảy ra.

**Lợi ích.**

- Một tệp khai báo (`config.yaml`) mô tả router và combo (bộ nạp cấu hình vẫn nhận `routersync.yaml` ở thư mục làm việc nếu có). Mỗi router trong `config.yaml` phải dùng một adapter khác nhau (ví dụ một `9router` và một `omniroute`); cấu hình có nhiều router cùng adapter sẽ bị từ chối kèm lỗi rõ ràng.
- Kế hoạch cho biết chính xác bước nào được thêm, đổi vị trí hoặc bỏ.
- Mỗi lần ghi đều có bản sao lưu trước và đọc lại sau.
- Khám phá model không tốn token suy luận: chỉ lấy danh sách model.

### Tính năng chính

- **Quét chỉ đọc** - đọc database router và danh sách model của nhà cung cấp.
- **Kế hoạch xác định** - cùng đầu vào luôn cho cùng một mã băm kế hoạch.
- **Xem trước thứ hạng** - hiện thứ tự combo mới mà không đụng router.
- **Kiểm chứng** - gán nhãn cho mọi model qua ba tầng (danh sách nhà cung
  cấp, danh mục ngoài, thông báo ngừng hỗ trợ).
- **Theo dõi 0 token** - `tick` canh danh mục và ghi vào hộp thư báo.
- **Máy chủ MCP** - 24 công cụ chỉ đọc, không có công cụ ghi.
- **Daemon và giao diện web** - bảng điều khiển cục bộ chỉ đọc.

#### Cách hoạt động

```text
  quét  ->  so sánh  ->   kế hoạch    ->   xác nhận   ->   sao lưu   ->   ghi hẹp   ->   đọc lại   ->   hoàn tác
   |          |              |                |              |              |              |              |
GET /models   |        chạy thử diff     gõ từ xác       chụp lại       chỉ ghi các     đọc lại       khôi phục
với khóa      |        + mã băm kế       nhận trên       database       bước trong      database      danh sách
của bạn       |        hoạch             terminal TTY    router         kế hoạch        router        bước cũ
```

#### Mô hình an toàn

Chỉ nêu những điều mà bộ kiểm thử chứng minh được.

| Quy tắc | Ý nghĩa |
|---|---|
| Mặc định chỉ đọc | `scan`, `plan`, `rank`, `verify`, `tick`, `daemon` không ghi vào router. |
| Cần người xác nhận | `sync --apply`, `undo --apply`, `rank --apply` và `rollback --write` từ chối chạy khi stdin không phải TTY, rồi yêu cầu gõ tay từ xác nhận. |
| Sao lưu trước khi ghi | Một lần ghi chụp lại những dòng router sắp thay đổi trước khi mở giao dịch. |
| Đọc lại sau khi ghi | Sau khi ghi, router được đọc lại qua đúng đường dẫn mà nó phục vụ. |
| Hoàn tác có giới hạn | `undo` khôi phục danh sách bước của bản sao lưu sync mới nhất. |
| 0 token suy luận | `tick` và các bộ quét chỉ gọi `GET /models`, không gọi endpoint chat hay completion. |
| Khóa ở lại máy bạn | Khóa API được đọc vào bộ nhớ, không in ra, không ghi vào kế hoạch hay nhật ký. |

#### Cài đặt

Yêu cầu giống nhau trên mọi nền tảng: **Node.js >= 22.12** và **pnpm >= 10**.
Thư viện SQLite (`better-sqlite3`) đi kèm bản dựng sẵn cho macOS (Intel và
Apple Silicon), Linux (x64 và arm64) và Windows ngay trong gói npm, nên
**không cần trình biên dịch C++ và không cần bước build thủ công**. Kho đã
ghim phiên bản trình quản lý gói trong `packageManager` và phiên bản Node
trong `.nvmrc`, nên `corepack enable pnpm` sẽ chọn đúng phiên bản.

> **Ghi chú về thư viện SQLite.** `pnpm install` in ra cảnh báo "Ignored
> build scripts: better-sqlite3" một cách có chủ đích: gói này đã kèm sẵn
> nhị phân biên dịch cho mọi nền tảng được hỗ trợ, và việc dựng lại từ mã
> nguồn sẽ đòi hỏi trình biên dịch C++. Cảnh báo này vô hại.

**Windows (PowerShell)**

```powershell
node --version          # phải là >= v22.12.0
corepack enable pnpm    # hoặc: npm install -g pnpm@10
git clone https://github.com/CThawngs/Router-Sync.git
cd Router-Sync
pnpm install --frozen-lockfile
pnpm build
New-Item -ItemType Directory -Force "$env:APPDATA\routersync" | Out-Null
Copy-Item ranking.example.yaml "$env:APPDATA\routersync\ranking.yaml"
node packages/cli/dist/index.js init     # tạo tệp cấu hình config.yaml mặc định
node packages/cli/dist/index.js scan     # lệnh chỉ đọc đầu tiên
```

**macOS (Terminal)**

```bash
node --version          # phải là >= v22.12.0
corepack enable pnpm    # hoặc: npm install -g pnpm@10
git clone https://github.com/CThawngs/Router-Sync.git
cd Router-Sync
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.config/routersync && cp ranking.example.yaml ~/.config/routersync/ranking.yaml
node packages/cli/dist/index.js init     # tạo tệp cấu hình config.yaml mặc định
node packages/cli/dist/index.js scan     # lệnh chỉ đọc đầu tiên
```

**Linux (Terminal)**

```bash
node --version          # phải là >= v22.12.0
corepack enable pnpm    # hoặc: npm install -g pnpm@10
git clone https://github.com/CThawngs/Router-Sync.git
cd Router-Sync
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.config/routersync && cp ranking.example.yaml ~/.config/routersync/ranking.yaml
node packages/cli/dist/index.js init     # tạo tệp cấu hình config.yaml mặc định
node packages/cli/dist/index.js scan     # lệnh chỉ đọc đầu tiên
```

> **Chạy lệnh qua `pnpm routersync`:** Bạn có thể gọi bất kỳ lệnh nào bằng
> `pnpm routersync <lệnh>` (ví dụ: `pnpm routersync doctor`) hoặc thông qua
> `node packages/cli/dist/index.js <lệnh>`.
> *Lưu ý:* Chạy `pnpm doctor` sẽ kích hoạt công cụ chẩn đoán môi trường nội
> bộ của pnpm (không xuất ra thông tin của RouterSync); hãy luôn dùng
> `pnpm routersync doctor`.

**Ví dụ đầu ra:** Kết quả hiển thị phụ thuộc vào router nào đang chạy trên máy của bạn. Ví dụ, khi OmniRoute đang tắt và 9Router đang chạy cục bộ nhưng chưa cấu hình khóa client:

```text
[routersync] Scanned 2 router(s) from <đường-dẫn-cấu-hình>:
  ✗ [omni] (omniroute) - Status: down (...) | Read-Back: db-only (degraded) | Combos: 0 | Models: 0
      Read-Back Info: Router API unreachable (fetch failed) - serving path unconfirmed, degraded to db-only
      Detail: fetch failed
  ✓ [nine] (9router) - Status: ok (...) | Read-Back: db-only (degraded) | Combos: 0 | Models: 0
      Read-Back Info: No client key configured. 9Router API requires browser session or NINEROUTER_CLIENT_KEY for /v1/models.
```

**Bảng đường dẫn cơ sở dữ liệu router mặc định:**

| Router | Hệ điều hành / Môi trường | Đường dẫn database mặc định | Biến môi trường ghi đè |
|---|---|---|---|
| 9Router | Windows | `%APPDATA%\9router\db\data.sqlite` | `ROUTERSYNC_9ROUTER_DB` (hoặc `${DATA_DIR}/db/data.sqlite` nếu có `DATA_DIR`) |
| 9Router | macOS / Linux | `~/.9router/db/data.sqlite` | `ROUTERSYNC_9ROUTER_DB` (hoặc `${DATA_DIR}/db/data.sqlite` nếu có `DATA_DIR`) |
| OmniRoute | Mọi nền tảng | `~/.omniroute/storage.sqlite` | `ROUTERSYNC_OMNIROUTE_DB` |

*Ghi chú: Đường dẫn 9Router trên macOS/Linux được xác định theo tài liệu và mã nguồn, chưa được tác giả chạy trên macOS/Linux thật.*

#### Cài đặt bằng AI Agent

Nếu bạn giao kho này cho một AI Agent (Claude Code, OpenCode, Codex, Gemini
CLI, Antigravity), hãy gửi câu lệnh duy nhất này:

> "Clone `<repo URL>`, đọc `AGENTS.md`, cài đặt RouterSync, và hỏi tôi trước
> mọi quyết định."

Agent sẽ chạy `pnpm routersync doctor --json`, làm theo `nextSteps`, và chỉ đề xuất
các hành động chỉ đọc. Mọi lệnh ghi (`sync --apply`, `undo --apply`,
`rank --apply`, `rollback --write`) phải do chính bạn gõ trong terminal của bạn — agent không bao
giờ tự gõ từ xác nhận thay bạn.

*Ghi chú: `routersync <lệnh>` trong tài liệu này chạy bằng `pnpm routersync <lệnh>`.*

#### Bảng lệnh CLI

| Lệnh | Việc nó làm | Ghi vào router? |
|---|---|---|
| `routersync init` | Viết tệp `config.yaml` mẫu. | Không |
| `routersync scan` | Đọc database router và danh sách của nhà cung cấp. | Không |
| `routersync plan` | Lập kế hoạch và in ra khác biệt. | Không |
| `routersync status` | Hiện tình trạng router và mức đọc lại. | Không |
| `routersync doctor` | Chẩn đoán cấu hình. | Không |
| `routersync verify` | Gán nhãn mọi model qua L1/L2/L3. | Không |
| `routersync tick` | Một vòng danh mục và hộp thư báo, 0 token. | Không |
| `routersync rank` | Xem trước thứ tự combo mới. | Không (trừ khi `--apply`) |
| `routersync sync` | Lập kế hoạch và, kèm `--apply`, ghi. | Chỉ khi `--apply` + TTY + từ xác nhận |
| `routersync undo` | Khôi phục danh sách bước của bản sao lưu sync mới nhất. | Chỉ khi `--apply` + TTY + từ xác nhận |
| `routersync rollback [id]` | Khôi phục một ảnh chụp đã lưu. | Chỉ khi `--write` + TTY + từ xác nhận |
| `routersync daemon` | Chạy daemon cục bộ chỉ đọc. | Không |
| `routersync inbox list\|ack\|snooze` | Xử lý hộp thư báo. | Không |
| `routersync mcp install` | In cấu hình máy chủ MCP cho ứng dụng khách. | Không |

#### Cấu hình máy chủ MCP cho ứng dụng khách

RouterSync có máy chủ MCP chỉ đọc với 24 công cụ. Dán đoạn này vào ứng dụng
khách MCP (đường dẫn là nơi bạn cài đặt):

```json
{
  "mcpServers": {
    "routersync": {
      "command": "node",
      "args": ["/absolute/path/to/routersync/packages/mcp-server/dist/index.js"],
      "env": {
        "ROUTERSYNC_STATE_DIR": "/absolute/path/to/state"
      }
    }
  }
}
```

#### Lịch chạy `tick`

`tick` chỉ đọc danh sách model, nên một lần chạy theo lịch tốn **0 token**.
Các mẫu dùng ngay nằm ở [`examples/schedule/`](examples/schedule/):

| Nền tảng | Tệp |
|---|---|
| Windows Task Scheduler | `examples/schedule/windows-task-scheduler.xml` |
| macOS launchd | `examples/schedule/macos-launchd.plist` |
| Linux systemd timer | `examples/schedule/linux-systemd-timer.service` + `.timer` |
| Linux cron | `examples/schedule/linux-cron.txt` |

#### Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| `Cannot open the router database at "..."` | Không tìm thấy database router. Dán đường dẫn được in ra vào `config.yaml` ở mục `routers[].db.path`, hoặc đặt `ROUTERSYNC_9ROUTER_DB` / `ROUTERSYNC_OMNIROUTE_DB`. |
| `Configuration file not found at: ...` | Chạy `routersync init` hoặc trỏ `ROUTERSYNC_CONFIG` vào tệp của bạn. |
| `Write Execution Blocked ... stdin is not a TTY` | Lệnh ghi cần có người. Hãy chạy trong terminal tương tác. |
| `No ranking policy file at ...` | Chép `ranking.example.yaml` tới vị trí được in ra. Công cụ vẫn chạy chỉ đọc, nhưng mọi đường ghi đều từ chối khi thiếu tệp này. |
| `Failed to load better-sqlite3 native addon` | Dựng lại module native: `pnpm rebuild better-sqlite3`. |
| `SHRINK-GUARD-BLOCKED` trong `status.json` hoặc dòng `PROVIDER` | Danh sách model của nhà cung cấp sụt giảm quá ngưỡng (mặc định 30%). Catalog cũ được giữ nguyên. Hãy đối chiếu danh sách chính thức của nhà cung cấp để phân biệt gỡ bỏ thật hay sự cố; nếu đúng là gỡ bỏ, người vận hành (không phải agent) có thể đặt lại baseline bằng cách xóa mục của nhà cung cấp đó trong `tick-catalog.json` hoặc chạy lại với `--max-shrink-ratio`. |
| Nhà cung cấp hiện `AUTH_ERROR` | Khóa trong database router đã hết hạn hoặc không hợp lệ. RouterSync không bao giờ in khóa. |

#### Bản đồ tài liệu

| Tài liệu | Nội dung |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Cài đặt lần đầu |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) / [`docs/WORKFLOW.vi.md`](docs/WORKFLOW.vi.md) | Quy trình dùng hằng ngày |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Điều sắp làm và điều đã biết là thiếu |
| [`docs/compat-matrix.md`](docs/compat-matrix.md) | Ma trận nền tảng và tính năng |
| [`docs/adapters/`](docs/adapters/) | Ghi chú theo từng router và harness |
| [`docs/adr/`](docs/adr/) | Biên bản quyết định kiến trúc |
| [`docs/runbook/`](docs/runbook/) | Runbook cho lần ghi đầu tiên |
| [`docs/security/`](docs/security/) | Mô hình đe doạ của daemon |
| [`examples/schedule/`](examples/schedule/) | Mẫu lịch chạy dùng ngay |
| [`CHANGELOG.md`](CHANGELOG.md) | Ghi chú phát hành |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Cách đóng góp |

### Kết luận

RouterSync cố ý thận trọng: nó đọc, nó lập kế hoạch, nó hỏi, và chỉ sau đó
mới ghi - và nó không ghi gì khi không ai đang nhìn. Nếu bạn muốn thử, hãy
chạy `routersync scan` trước. Lệnh đó không thay đổi gì cả.

### Tuyên bố miễn trừ

RouterSync không liên kết với, không được 9Router, OmniRoute, OpenAI, Google,
Anthropic hay bất kỳ nhà cung cấp nào bảo trợ hay chấp thuận. Tên và logo sản
phẩm thuộc về chủ sở hữu tương ứng và chỉ được dùng để mô tả những gì công
cụ này kết nối tới.

Phần mềm được cung cấp "NGUYÊN TRẠNG", không kèm bảo đảm dưới bất kỳ hình
thức nào, theo giấy phép [MIT](LICENSE).

Bạn chịu trách nhiệm về mọi lần ghi vào router của chính bạn. RouterSync có
xin xác nhận trước khi ghi, nhưng hậu quả của một lần ghi thuộc về bạn.

Công cụ gọi `GET /models` bằng **khóa API của chính bạn** - khóa vốn đã nằm
trong database router của bạn - và đọc các trang danh mục công khai
(OpenRouter, models.dev, LiteLLM và trang thông báo ngừng hỗ trợ của nhà
cung cấp). Nó không bao giờ gọi endpoint chat hay completion, nên việc khám
phá model tốn 0 token.
