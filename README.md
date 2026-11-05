# QC Warehouse

通用第三方实物检查平台。英文客户门户、中文仓库台与管理后台使用同一 PostgreSQL 数据库、同一交易接口和同一工作进程。服装是默认演示目录，品类字段由模板配置。

产品边界和上线门禁见 [PRD v3.2](docs/QCWarehouse_PRD_v3_MultiCategory.md)。实施细节见 [开发规格](docs/开发规格.md)，任务依赖与实测状态见 [开发排期与任务台账](docs/开发排期与任务台账.md)。

## 本地启动

需要 Node.js 22 或更新版本，以及 PostgreSQL 16。可以使用本地已有数据库，也可以启动 Compose 中的开发数据库。

```bash
npm ci
docker compose up -d db
cp .env.example .env
openssl rand -hex 32
```

在 `.env` 中将随机值填入 `AUTH_OTP_PEPPER`，设 `QCW_DEMO=1`。如使用已有数据库，将 `DATABASE_URL` 改为本地开发库的连接字符串。

```bash
npm run db:migrate
npm run db:demo
npm run dev
```

在另一个终端运行 `npm run worker` 处理 PDF、物流回调和站内通知。浏览器打开 `http://localhost:3000`。客户从 `/login` 注册，仓库从 `/wh` 进入，管理后台在 `/admin`。本地演示客户使用新的 `@qcw.test` 邮箱。员工用 `receiving@qcw.test`、`inspector@qcw.test`、`reviewer@qcw.test`、`admin@qcw.test` 登录。验证码在本地页面显示。演示仓址与运价是测试数据，付款通过本地模拟确认。

## 重跑验证

```bash
npm run check
npm run build
python3 docs/contracts/check.py
docker compose exec -T db createdb -U qcwarehouse qcw_test
```

在 `.env` 设置 `TEST_DATABASE_URL=postgres://qcwarehouse:qcwarehouse@localhost:5432/qcw_test`，运行 `npm run test:integration`。测试用独立数据库，自动迁移并写入演示数据。箱包和家居模板仅在测试数据库激活。数据库关系用例须在已迁移、未写入演示数据的空库执行 `psql -v ON_ERROR_STOP=1 -f docs/contracts/verify.sql`。

## 外部服务联调

运行 `npm run integrations:check` 查看配置状态，或由超管通过 `GET /api/v1/staff/admin/tracking/health` 查看快递100配置。两者均只做本地检查，输出不含密钥、不调用外部服务，也不验证账号权限、实际额度和投递结果。接入时使用独立测试环境，关闭 `QCW_DEMO`。

| 服务 | 配置与联调入口 |
|---|---|
| Google / Microsoft | 分别填入客户端 ID 与密钥，登记预检输出的完整回调地址。Microsoft 按个人账号授权。首次 Microsoft 登录另需验证通知邮箱。 |
| Stripe | 测试密钥与同环境签名密钥成对配置。回调 `POST /api/v1/webhooks/stripe`。使用测试密钥运行端到端付款和退款后再留证。正式收款默认关闭。 |
| Postmark | 填入测试 Server Token、已验证的发件地址与交易消息流 `POSTMARK_MESSAGE_STREAM`。`POSTMARK_API_TEST` 用于请求格式测试，应用验证码流程要求可实际提交的凭证。 |
| 快递100 | 配置企业 key/customer 及 HTTPS 回调根地址，服务端生成订阅回调地址。Worker 负责查询、订阅、回调消费。分别留证中文推送、英文查询、电话校验与入仓、集运、退商家链路。 |

开发联调可使用 `npm run test:integration`。供应商夹具覆盖 OAuth 发起与回调防重放、Postmark 响应处理、Stripe 签名和支付去重、快递100查询及回调。测试不会使用真实账号。

供应商设置依据：[Stripe Checkout 与回调](https://docs.stripe.com/checkout/fulfillment?ui=full-page)、[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)、[Microsoft 个人账号 OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)、[Postmark 发送 API](https://postmarkapp.com/developer/api/email-api)、[快递100实时查询](https://api.kuaidi100.com/document/5f0ffb5ebc8da837cbd8aefc)。

## 集成和发布状态

- 核心迁移、37 个交易接口入口和本地集成测试已落盘。自动测试覆盖三品类履约、30 件逐件加 3 件对比任务、未认领件人工核验、物流回调、越权与重复动作、人工报价。
- Google、Microsoft、Postmark、Stripe 和快递100的配置见 [环境变量示例](.env.example)。当前邮件适配覆盖验证码，物流双语分别使用英、中文快照。真实凭证、完整英文轨迹样本、承运商覆盖及实际回调仍待独立联调。
- 生产门禁仍按 PRD §17 与规格 §23。任务台账保留账号安全与恢复、邮件退信、物流纠错、异常履约和实仓验收的未完工作。开发仓址、收费与政策均需换为正式发布版本。
