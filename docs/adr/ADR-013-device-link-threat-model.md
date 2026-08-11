# ADR-013：Device Link 身份、配对与移动端威胁模型

- 状态：Accepted
- 日期：2026-08-11
- 决策范围：桌面 Device Link、Android companion、文件/会话/审批传输

## 资产与信任边界

受保护资产包括设备私钥、provider 凭证、会话、workspace、artifact、审批权和麦克风权限。手机与电脑是独立 tenant 和独立工作区；配对只建立设备关系，不复制凭证、不产生隐式双写。

网络、二维码、mDNS 发现、远程内容、分享文件和 relay 均不可信。GUI HTTP API 与 Remote Job 队列不作为移动端协议边界；Device Link 复用 App Server 应用方法，并新增独立 transport/auth 层。

## 决定

1. LAN 为默认连接：mDNS/NSD 发现，QR 或手动地址配对，证书指纹确认，后续证书固定的双向认证 WSS。
2. 每个请求校验设备身份、最小 capability scope、monotonic sequence、nonce、时钟偏差、rate limit 与审计记录。
3. Capability 分别授权浏览会话、发送 prompt、远程审批、文件传输、麦克风和实时音频；配对不等于全权限。
4. 会话同步只产生只读 cache 或显式 copy；copy 创建新 session 并记录 origin metadata。
5. 文件先进入 quota 受限的 inbox/quarantine，校验 chunk/整包 hash 后由用户显式提交到 workspace。
6. 凭证只保存在各设备安全存储；电脑凭证不自动复制到手机，kernel/remote peer 也不得获取主进程 secrets。
7. 跨 NAT 按 LAN/direct、用户 SSH/tunnel、自建 relay/WebRTC 分级；无可达路径时报告真实失败。
8. 撤销设备、证书变化、密钥失效或锁屏状态必须使高风险 capability fail closed。

## 主要威胁与缓解

- 未配对访问/MITM：双向设备身份、短期配对 challenge、指纹确认与 pinning。
- token/帧重放：sequence、nonce、有效窗口和持久 replay ledger。
- 越权审批：绑定目标设备、workspace、tool、参数摘要和前台用户确认。
- 路径穿越/恶意压缩包：无绝对路径、zip-slip 防护、符号链接/设备文件拒绝。
- relay 窥探：端到端加密帧；relay 只做 signaling/opaque forwarding。
- 离线冲突：不对同一 session/path 隐式双写。

## 测试证据

Phase 6/7 必须覆盖未配对访问、replay、换证书、撤销、越权 approval、clock skew、断点续传、SAF 授权撤销和恶意文件。

## 回滚方式

网络 transport 可整体关闭而保留本地 App Server。安全检查不得降级为警告；后端不可用时只允许本地/只读缓存能力。
