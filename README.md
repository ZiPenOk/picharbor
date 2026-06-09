# PicHarbor

PicHarbor 是一个自托管的套图下载与媒体管理 Web 应用。它把站点适配器、下载队列、图片/视频媒体库、相册查看和播放体验放在同一个工作台里，适合部署在 NAS 或本地服务器上长期运行。

当前项目采用单容器结构：Node API 负责下载和媒体服务，React/Vite 前端由同一个 Node 服务静态托管。后续如果需要独立 worker、数据库或缩略图服务，可以再拆成多容器。

## 当前能力

- Web 登录鉴权，默认首次启动会生成 `admin / admin`，可在设置页修改账号和密码。
- 下载任务管理：批量 URL 输入、排队、暂停、继续、失败重试、任务详情。
- 单任务串行下载，避免多个站点任务同时抢网络和触发风控。
- 支持图片与视频入库，视频排序在相册第一位，并可使用相册首图作为封面。
- 媒体库按相册浏览，支持图片弹窗、缩放、拖拽、键盘切换和幻灯片播放。
- 设置页集中管理站点 Cookie、代理、FlareSolverr 地址和账号信息。
- 下载前 URL 诊断：识别适配器、Cookie 状态、FlareSolverr 配置和支持能力。
- Docker 数据持久化，媒体文件与配置文件分离挂载。

## 已接入适配器

- xChina: `https://xchina.co/photo/id-*.html`
- 六色网: `https://www.06se.com/*.html`
- 8色: `https://tw.8se.me/photo/id-*.html`
- 栖光集: `https://xrw-album.christin3.com/telegraph-album/*`

适配器代码集中在 `server/adapters/`。新增站点时优先新增独立 adapter，并在 `server/adapters/index.js` 注册。

## 本地开发

环境要求：

- Node.js 22+
- npm

安装依赖并启动前后端开发服务：

```bash
npm install
npm run dev:all
```

默认地址：

- Web: `http://127.0.0.1:5173/`
- API: `http://127.0.0.1:4177/api/health`

生产模式本地运行：

```bash
npm run build
npm start
```

然后打开 `http://127.0.0.1:4177/`。

## Docker 部署

项目内置 `Dockerfile` 和 `docker-compose.yml`。默认容器端口为 `4177`。

```bash
docker compose up -d --build
```

推荐挂载两个持久化目录：

```text
/media   -> 下载回来的图片和视频
/config  -> 登录配置、会话、Cookie、代理、任务与相册索引
```

Synology 示例：

```text
/volume1/Nas/downloads/PicHarbor:/media
/volume1/docker/PicHarbor:/config
```

下载后的目录结构：

```text
/media/<站点>/<标题>/<媒体文件>
```

例如：

```text
/volume1/Nas/downloads/PicHarbor/xChina/example-album/001.jpg
```

## 配置文件

容器内默认配置路径：

- Cookie 目录：`/config/cookies`
- 代理配置：`/config/proxy.txt`
- FlareSolverr 地址：`/config/flaresolverr.txt`
- 登录配置：`/config/auth.json`
- 会话文件：`/config/sessions.json`

这些文件都属于运行时私有数据，不应提交到 Git。

Cookie 可以在 Web 设置页按站点集中保存，支持 Netscape cookie txt 和普通 `Cookie: a=b; c=d` 请求头格式。

## Cloudflare 与代理

部分站点会对 NAS 或容器网络返回 403。PicHarbor 支持两种辅助方式：

- 在设置页填写 HTTP/SOCKS 代理。
- 在设置页填写 FlareSolverr 地址，例如 `http://<host>:8191`。

站点适配器会尽量按顺序尝试普通请求、Cookie 请求、代理请求和 FlareSolverr。不同站点的风控策略不同，仍可能需要先在浏览器完成验证，再导出有效 Cookie。

## 常用接口

- `GET /api/health`
- `GET /api/auth/status`
- `POST /api/auth/login`
- `POST /api/auth/update`
- `GET /api/app-data`
- `GET /api/tasks`
- `POST /api/tasks`
- `POST /api/tasks/inspect`
- `POST /api/tasks/:id/pause`
- `POST /api/tasks/:id/resume`
- `POST /api/tasks/:id/retry`
- `GET /api/settings`
- `POST /api/settings`

大部分 `/api`、`/media` 和 `/thumb` 路由需要登录会话。

## 开发注意

- `server/downloads/`、`server/tmp/`、`dist/`、部署压缩包、调试 HTML 和 Cookie 文件都被 `.gitignore` 排除。
- 如果本地已有真实下载样例，它们只用于调试，不会进入仓库。
- 新增适配器时，要保证解析出的媒体顺序与网页展示或加载顺序一致。
- 视频资源应带 `mediaType: 'video'`，并尽量提供或复用相册封面。

## 校验命令

```bash
npm run build
npm run lint
```
