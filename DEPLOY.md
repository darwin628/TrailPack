# TrailPack 部署说明

## 方案 A: Render（推荐，最省事）

本项目已支持单服务部署：后端 API 与前端静态文件由同一个 Node 服务提供。

### 1. 推送代码到 GitHub

```bash
git init
git add .
git commit -m "deploy: setup production"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. 在 Render 创建 Web Service

1. 打开 Render 控制台，新建 `Web Service`。
2. 选择你的 GitHub 仓库。
3. Render 会自动读取仓库根目录的 `render.yaml`。
4. 点击创建并等待构建完成。

### 3. 关键配置（已在 `render.yaml` 中定义）

- Build Command: `npm ci && npm run build`
- Start Command: `npm start`
- Health Check: `/api/health`
- 持久化磁盘挂载: `/var/data`
- SQLite 文件: `/var/data/trailpack.db`

部署成功后，会得到一个 `https://xxxx.onrender.com` 链接，其他人可直接访问。

## 方案 B: Docker + 自己的云服务器

### 1. 本地构建镜像

```bash
docker build -t trailpack:latest .
```

### 2. 运行容器（带数据卷）

```bash
docker run -d \
  --name trailpack \
  -p 4000:4000 \
  -e NODE_ENV=production \
  -e JWT_SECRET='replace-with-a-strong-secret' \
  -e DB_PATH='/data/trailpack.db' \
  -v trailpack_data:/data \
  trailpack:latest
```

### 3. 域名访问

将你的域名反向代理到服务器 `4000` 端口（Nginx/Caddy 均可）。

## 生产建议

- 必须设置强随机 `JWT_SECRET`。
- 若是同域部署，`CORS_ORIGIN` 可保持 `*` 或指定域名。
- 若将来并发用户较多，建议把 SQLite 升级为 Postgres。
