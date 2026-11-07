-- 商品订单录入系统 - 全量建表脚本（幂等，可重复执行）

-- 用户表
CREATE TABLE IF NOT EXISTS public.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  phone         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.users IS '系统用户';

-- 字典种类
CREATE TABLE IF NOT EXISTS public.dict_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.dict_types IS '字典种类';

-- 字典键值对
CREATE TABLE IF NOT EXISTS public.dict_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id    uuid        NOT NULL REFERENCES public.dict_types(id) ON DELETE CASCADE,
  k          text        NOT NULL,
  v          text        NOT NULL DEFAULT '',
  sort       integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dict_items_type ON public.dict_items(type_id, sort);
COMMENT ON TABLE public.dict_items IS '字典键值对';

-- 操作日志
CREATE TABLE IF NOT EXISTS public.op_logs (
  id         bigserial PRIMARY KEY,
  user_id    uuid,
  user_name  text,
  method     text        NOT NULL,
  path       text        NOT NULL,
  status     integer     NOT NULL,
  ip         text,
  cost_ms    integer,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_op_logs_created ON public.op_logs(created_at DESC);
COMMENT ON TABLE public.op_logs IS '接口操作日志';

-- 订单大类（fields 为字段定义数组 jsonb：[{key,label,type}] type: text|number|date）
CREATE TABLE IF NOT EXISTS public.categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  fields     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.categories IS '订单大类及其字段定义';

-- 订单（data 为动态字段值 jsonb，结构由所属大类的 fields 决定）
CREATE TABLE IF NOT EXISTS public.orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid        NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,
  status      text        NOT NULL DEFAULT 'pending',   -- pending 未收货 / received 已收货 / shipped 已出库
  shipment_id uuid,
  shipped_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_category ON public.orders(category_id, created_at DESC);
-- 兼容旧库：补充新增列（索引须在加列之后创建）
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipment_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipped_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS recharge_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS recharge_used numeric(12,2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_recharge ON public.orders(recharge_id);
COMMENT ON TABLE public.orders IS '订单数据';

-- 充值金账户（余额 = 得到的金额 - 关联订单已使用金额）
CREATE TABLE IF NOT EXISTS public.recharges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text          NOT NULL,
  amount     numeric(12,2) NOT NULL DEFAULT 0,
  bonus      numeric(12,2) NOT NULL DEFAULT 0,
  total      numeric(12,2) NOT NULL DEFAULT 0,
  remark     text          NOT NULL DEFAULT '',
  created_at timestamptz   NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.recharges IS '充值金账户';

-- 回收商品（种类 + 回收单价 + 所属大类 + 颜色标记）
CREATE TABLE IF NOT EXISTS public.recycle_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text          NOT NULL UNIQUE,
  price       numeric(12,2) NOT NULL DEFAULT 0,
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  color       text          NOT NULL DEFAULT '',
  created_at  timestamptz   NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.recycle_items IS '回收商品种类及单价（可归属大类，带颜色标记）';

-- 回收商品兼容旧库：补充大类列、颜色列
ALTER TABLE public.recycle_items ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL;
ALTER TABLE public.recycle_items ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '';

-- 出货记录兼容旧库：补充新增列
ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS shipper text NOT NULL DEFAULT '';
ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS payment_received boolean NOT NULL DEFAULT false;
ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS remark text NOT NULL DEFAULT '';

-- 出货记录（一次发货一条，含快递信息与利润快照）
CREATE TABLE IF NOT EXISTS public.shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  express_company text        NOT NULL,
  express_no      text        NOT NULL DEFAULT '',
  express_fee     numeric(12,2) NOT NULL DEFAULT 0,
  total_cost      numeric(12,2) NOT NULL DEFAULT 0,
  total_recovered numeric(12,2) NOT NULL DEFAULT 0,
  total_profit    numeric(12,2) NOT NULL DEFAULT 0,
  order_count     integer     NOT NULL DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.shipments IS '出货记录';

-- 出货-订单关联（快照订单数据，防止订单后续修改/删除影响历史记录）
CREATE TABLE IF NOT EXISTS public.shipment_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid  NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  order_id    uuid,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_shipment_orders_ship ON public.shipment_orders(shipment_id);
COMMENT ON TABLE public.shipment_orders IS '出货记录关联订单快照';

-- ============================================================
-- 家庭管理与 RBAC 权限体系
-- ============================================================

-- 家庭（数据隔离的最小单位）
CREATE TABLE IF NOT EXISTS public.families (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  province   text        NOT NULL DEFAULT '',   -- 省
  city       text        NOT NULL DEFAULT '',   -- 市
  district   text        NOT NULL DEFAULT '',   -- 区县
  street     text        NOT NULL DEFAULT '',   -- 乡镇街道
  community  text        NOT NULL DEFAULT '',   -- 小区
  house_no   text        NOT NULL DEFAULT '',   -- 门牌号
  lng        double precision,                  -- 经度
  lat        double precision,                  -- 纬度
  created_at timestamptz NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.families IS '家庭（组织单元）';

-- 角色
CREATE TABLE IF NOT EXISTS public.roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text        NOT NULL UNIQUE,       -- super_admin / family_head / family_member
  name       text        NOT NULL,
  is_system  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.roles IS '角色（系统内置三种，不可删除）';

-- 权限点（按模块划分）
CREATE TABLE IF NOT EXISTS public.permissions (
  code   text PRIMARY KEY,
  name   text NOT NULL,
  module text NOT NULL DEFAULT ''
);
COMMENT ON TABLE public.permissions IS '权限点';

-- 角色-权限
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id   uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  perm_code text NOT NULL REFERENCES public.permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, perm_code)
);
COMMENT ON TABLE public.role_permissions IS '角色与权限关联';

-- 用户-角色
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
COMMENT ON TABLE public.user_roles IS '用户与角色关联';

-- 兼容旧库：users 补充家庭、与户主关系
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES public.families(id) ON DELETE SET NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS relation text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_family ON public.users(family_id);

-- 兼容旧库：业务表补充家庭列（orders/shipments/recharges/recycle_items 随家庭级联删除，日志置空）
ALTER TABLE public.categories    ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES public.families(id) ON DELETE CASCADE;
ALTER TABLE public.orders        ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES public.families(id) ON DELETE CASCADE;
ALTER TABLE public.shipments     ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES public.families(id) ON DELETE CASCADE;
ALTER TABLE public.recharges     ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES public.families(id) ON DELETE CASCADE;
ALTER TABLE public.recycle_items ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES public.families(id) ON DELETE CASCADE;
ALTER TABLE public.op_logs       ADD COLUMN IF NOT EXISTS family_id uuid;
ALTER TABLE public.dict_types    ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES public.families(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_categories_family    ON public.categories(family_id);
CREATE INDEX IF NOT EXISTS idx_orders_family        ON public.orders(family_id);
CREATE INDEX IF NOT EXISTS idx_shipments_family     ON public.shipments(family_id);
CREATE INDEX IF NOT EXISTS idx_recharges_family     ON public.recharges(family_id);
CREATE INDEX IF NOT EXISTS idx_recycle_items_family ON public.recycle_items(family_id);
CREATE INDEX IF NOT EXISTS idx_op_logs_family       ON public.op_logs(family_id);
CREATE INDEX IF NOT EXISTS idx_dict_types_family    ON public.dict_types(family_id);

-- 名称唯一约束改为「家庭内唯一」（全局字典 family_id 为 NULL 视为一个虚拟组）
ALTER TABLE public.categories DROP CONSTRAINT IF EXISTS categories_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_scope
  ON public.categories (COALESCE(family_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
ALTER TABLE public.recycle_items DROP CONSTRAINT IF EXISTS recycle_items_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recycle_items_scope
  ON public.recycle_items (COALESCE(family_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
ALTER TABLE public.dict_types DROP CONSTRAINT IF EXISTS dict_types_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dict_types_scope
  ON public.dict_types (COALESCE(family_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
