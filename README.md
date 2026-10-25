# Repo Meta

在 GitHub / Gitee 仓库页面补上平台没有直接给出来的信息：仓库创建时间、最后一次 push、项目年龄、活跃度、体积。

写它是因为经常要判断一个仓库还值不值得用。页面上只能看到「3 周前更新」这种相对时间，而「更新」把开 Issue、改简介都算进去了，跟代码进展是两回事。想看真实情况得开 F12 翻 API，翻烦了，干脆写个脚本贴在页面上。

（界面截图以后补在这儿，先把功能写明白）

## 显示内容

仓库首页右侧 About / 简介 区域会多出一张卡片：

| 条目 | 说明 |
| --- | --- |
| 创建时间 | 仓库建立时间 |
| 最后推送 | 代码最后一次 `git push`，对应接口的 `pushed_at` |
| 最后更新 | 仓库信息最后一次变更，对应 `updated_at` |
| 项目年龄 | 从创建到现在 |
| 代码活跃度 | 按最后一次 push 判断：活跃 / 较活跃 / 一般 / 冷淡 / 沉寂 |
| 仓库大小 | 自动换算 KB / MB / GB。Gitee 接口不保证返回体积，拿不到就不显示这一行 |

悬停每一项能看到完整时间戳和字段说明。

### 「最后推送」和「最后更新」经常不一样，是正常的

- **最后推送**（`pushed_at`）只有推代码才会变。
- **最后更新**（`updated_at`）范围大得多：Issue、PR、Release、Wiki、改仓库简介都会刷新它。

所以「最后更新」比「最后推送」新，说明最近有人开 Issue 或发版本，但没推代码。**看代码进度用「最后推送」，看仓库动静用「最后更新」。**

## 安装

先装脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [ScriptCat](https://scriptcat.org/) 都行。

然后二选一：

- **GitHub 源**：[点这里安装](https://github.com/wkkwky/repo-meta/raw/main/github-gitee-repo-meta.user.js)，管理器会弹出安装确认页
- **Greasyfork**：[点这里安装](https://greasyfork.org/zh-CN/scripts/602157)

管理器不认的话手动装：面板 → 添加新脚本 → 清空编辑器 → 把 `github-gitee-repo-meta.user.js` 全文粘进去 → 保存。

装完打开任意 GitHub / Gitee 仓库首页，右侧栏就能看到 **QUICK METADATA** 卡片。

## Gitee 需要配一次令牌

Gitee 的 OpenAPI 不接受匿名请求（直接 404），必须带私人令牌，所以用 Gitee 前配一次：

1. Gitee 右上角头像 → **设置** → 左侧 **私人令牌** → 生成新令牌
2. 权限只勾 **`projects`** 就够了，填个描述提交
3. 令牌只显示一次，马上复制
4. 打开任意 Gitee 页面，F12 控制台执行：

   ```js
   localStorage.setItem('repoMeta:giteeToken', '这里粘贴令牌')
   ```

5. 刷新页面

令牌存在你自己浏览器的 localStorage 里，只在请求 `gitee.com/api/v5` 时作为参数带上。想删掉：

```js
localStorage.removeItem('repoMeta:giteeToken')
```

## GitHub 令牌（可选）

GitHub 未登录 API 限额每小时 60 次，脚本有 6 小时缓存，正常逛够用。不够的话：

```js
localStorage.setItem('repoMeta:ghToken', 'ghp_你的令牌')
```

只给公开仓库的读权限就行。

## 悬浮面板

默认关。开启后任何仓库页面（包括 Issues、PR）都会有一块可以拖的浮动面板。

开关在信息卡右上角 **⚙** 里。

| 操作 | 效果 |
| --- | --- |
| 拖标题栏 | 移动位置，会记住 |
| **−** | 收起 / 展开 |
| **×** | 三种关闭：只关这一次（刷新恢复）、24 小时不再显示、彻底关掉 |
| **⚙** | 悬浮面板总开关 |

菜单点面板以外的位置会自己收起。关掉以后想再开，三个办法任选：

1. 仓库首页卡片上点 **⚙** 打开开关
2. Tampermonkey 图标 → 菜单「Repo Meta：开启 / 关闭悬浮面板」
3. 控制台执行 `repoMetaSettings({ float: true })`

## 出问题先自己查

控制台执行 `repoMetaDoctor()`，会把当前页面解析结果、卡片状态、设置内容全打出来。提 Issue 时附上它的输出。

几个常见情况：

- **卡片没出现**：确认在仓库首页（地址形如 `github.com/用户名/仓库名`），脚本已启用
- **Gitee 显示获取失败**：九成是令牌没配，按上面配一次
- **GitHub 提示限流**：等一小时，或者配令牌
- **时间不对**：按浏览器本地时区显示的，悬停看原始时间戳

## 数据来源与隐私

只发两类请求：

- `https://api.github.com/repos/{owner}/{repo}`
- `https://gitee.com/api/v5/repos/{owner}/{repo}`

不加载任何第三方资源，不收集、不上传浏览记录，不向其他服务器发送数据。查询结果按仓库缓存在本地 localStorage 中，有效期 6 小时。

## 常见问题

**信息卡没有出现？**

确认打开的是仓库首页（地址形如 `github.com/用户名/仓库名`），并且脚本已在 Tampermonkey 中启用。也可以在控制台执行 `repoMetaDoctor()`，它会输出当前页面的解析结果、卡片状态和设置内容。

**Gitee 上显示「获取失败」？**

通常是还没有配置私人令牌，按上文「Gitee 需要配置访问令牌」操作一次即可。

**GitHub 上显示「限流」？**

未登录状态下 API 每小时 60 次。等待一段时间，或者配置 GitHub 令牌。

**时间看起来不对？**

时间是按浏览器本地时区显示的。悬停可以看到原始时间戳。

**为什么有些仓库没有「仓库大小」这一行？**

体积来自平台的仓库接口，而两个平台对这项数据的支持程度不同：

- GitHub 的接口固定返回 `size`（单位 KB），因此 GitHub 仓库一定能显示。
- Gitee 的接口不保证返回体积字段，部分仓库根本没有这项数据。

对于拿不到体积的仓库，脚本会直接隐藏「仓库大小」这一行，而不是显示一个占位符。这不是脚本故障，也不影响其它条目。

想确认某个 Gitee 仓库到底有没有这项数据，可以在仓库页按 F12 执行：

```js
fetch('https://gitee.com/api/v5/repos/{owner}/{repo}?access_token=' +
  encodeURIComponent(localStorage.getItem('repoMeta:giteeToken')))
  .then(r => r.json())
  .then(d => console.log(Object.keys(d), 'size =', d.size))
```

若输出中没有 `size` 字段，说明该平台未提供，无法通过脚本补全（需要遍历文件树累加统计，请求量过大，未采用）。

## 已知限制

- Gitee 必须配令牌，匿名调不通
- 私有仓库要配有读权限的令牌
- 仓库体积 GitHub 固定有，Gitee 部分仓库接口不返回，那种情况这一行直接不显示
- 自建 Gitee 企业版 / GitHub Enterprise 没适配
- 页面改版可能找不到插入位置，脚本会自动退成悬浮面板，不至于看不到

## 更新日志

- **1.2.8**（2026-10-25）补齐发布用的元信息（主页、反馈地址、更新地址等），调试日志默认关闭
- 更早的版本都在本地改，没留记录，从这版开始记

## 反馈

有问题去 [Issues](https://github.com/wkkwky/repo-meta/issues) 提，附上 `repoMetaDoctor()` 的输出。

## License

[MIT](LICENSE)
