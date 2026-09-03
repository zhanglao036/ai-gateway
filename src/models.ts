import type { Model, Env, Provider, TierStorage } from './types'
import { getProviders, setProviders, kvPut, flushPendingWrites } from './storage'
import { KV_KEYS } from './config'

/**
 * 模型智能自动分类
 * 根据模型名称关键词自动标记类型：文本 / 绘图 / 多模态 / 其他
 */
export function autoClassifyModel(modelId: string): '文本' | '绘图' | '多模态' | '其他' {
  if (!modelId) return '其他'
  const name = modelId.toLowerCase()

  // 绘图关键词
  if (
    name.includes('dall-e') ||
    name.includes('midjourney') ||
    name.includes('stable-diffusion') ||
    name.includes('flux') ||
    name.includes('imagen') ||
    name.includes('cogview') ||
    name.includes('playground') ||
    name.includes('sdxl') ||
    name.includes('image') ||
    name.includes('绘图') ||
    name.includes('draw') ||
    name.includes('paint')
  ) {
    return '绘图'
  }

  // 多模态关键词
  if (
    name.includes('vision') ||
    name.includes('vl') ||
    name.includes('omni') ||
    name.includes('4o') ||
    name.includes('gemini-1.5') ||
    name.includes('gemini-2.0') ||
    name.includes('claude-3-5') ||
    name.includes('claude-3-7') ||
    name.includes('claude-3') ||
    name.includes('multimodal') ||
    name.includes('多模态') ||
    name.includes('audio') ||
    name.includes('speech') ||
    name.includes('realtime')
  ) {
    return '多模态'
  }

  // 文本关键词
  if (
    name.includes('gpt') ||
    name.includes('deepseek') ||
    name.includes('qwen') ||
    name.includes('claude') ||
    name.includes('llama') ||
    name.includes('mistral') ||
    name.includes('gemma') ||
    name.includes('chat') ||
    name.includes('text') ||
    name.includes('coder') ||
    name.includes('r1') ||
    name.includes('v3') ||
    name.includes('command')
  ) {
    return '文本'
  }

  return '其他'
}

/**
 * 同一个提供商下模型 ID 不可重复，规范化并自动剔除重复模型
 */
export function deduplicateAndClassifyModels(modelsInput: unknown): Model[] {
  if (!Array.isArray(modelsInput)) return []
  const result: Model[] = []
  const seenIds = new Set<string>()

  for (const item of modelsInput) {
    if (!item) continue
    let id = ''
    let enabled = true
    let category: string | undefined = undefined
    let failureCount = 0
    let cooldownUntil: number | null = null
    let permanentlyDisabled = false
    let disabledReason: string | null = null
    let lastPermTestAt: number | undefined = undefined
    let permTestFailCount: number | undefined = undefined

    if (typeof item === 'string') {
      id = item.trim()
    } else if (typeof item === 'object') {
      const obj = item as Record<string, unknown>
      id = String(obj.id || '').trim()
      enabled = obj.enabled !== undefined ? !!obj.enabled : true
      if (typeof obj.category === 'string' && obj.category) {
        category = obj.category
      }
      if (typeof obj.failureCount === 'number') {
        failureCount = obj.failureCount
      }
      if (typeof obj.cooldownUntil === 'number') {
        cooldownUntil = obj.cooldownUntil
      }
      if (typeof obj.permanentlyDisabled === 'boolean') {
        permanentlyDisabled = obj.permanentlyDisabled
      }
      if (typeof obj.disabledReason === 'string') {
        disabledReason = obj.disabledReason
      }
      if (typeof obj.lastPermTestAt === 'number') {
        lastPermTestAt = obj.lastPermTestAt
      }
      if (typeof obj.permTestFailCount === 'number') {
        permTestFailCount = obj.permTestFailCount
      }
    }

    if (!id || seenIds.has(id)) continue
    seenIds.add(id)

    result.push({
      id,
      enabled,
      category: category || autoClassifyModel(id),
      failureCount,
      cooldownUntil,
      permanentlyDisabled,
      disabledReason,
      lastPermTestAt,
      permTestFailCount,
    })
  }

  return result
}

/**
 * 一键重置全局所有模型至刚添加时的初始状态：
 * 1. 清空所有累计失败计数 (failureCount = 0)
 * 2. 清除冷却状态 (cooldownUntil = null)
 * 3. 清除永久失效与封禁标记 (permanentlyDisabled = false, disabledReason = null)
 * 4. 清除探针复测失败标记 (permTestFailCount = 0, lastPermTestAt = null)
 * 5. 确保模型标记为启用状态 (enabled = true)
 * 6. 同步重置梯队监控数据，清空历史异常统计，使全系统梯队重新就绪
 */
export async function resetAllModelsToInitial(env: Env): Promise<{ totalReset: number; providerCount: number }> {
  const providers = await getProviders(env)
  let totalReset = 0
  let providerCount = 0

  const updatedProviders = providers.map((provider) => {
    let providerChanged = false
    const updatedModels = provider.models.map((model) => {
      totalReset++
      providerChanged = true
      return {
        ...model,
        enabled: true,
        failureCount: 0,
        cooldownUntil: null,
        permanentlyDisabled: false,
        disabledReason: null,
        permTestFailCount: 0,
        lastPermTestAt: undefined,
      }
    })

    if (providerChanged) {
      providerCount++
      return {
        ...provider,
        models: updatedModels,
        updatedAt: new Date().toISOString(),
      }
    }
    return provider
  })

  await setProviders(env, updatedProviders)

  // 同步重置梯队监控数据到初始状态
  try {
    const now = Date.now()
    const today = new Date().toISOString().split('T')[0]

    const allAvailable = updatedProviders
      .filter((p) => p.enabled)
      .flatMap((p) =>
        p.models
          .filter((m) => m.enabled)
          .map((m) => ({
            providerId: p.id,
            modelId: m.id,
            fullId: `${p.id}/${m.id}`,
            addedAt: now,
          }))
      )

    const cleanTierStorage: TierStorage = {
      tier1: allAvailable.slice(0, 9),
      tier2: allAvailable.slice(9),
      probeStats: {},
      businessStats: {},
      updatedAt: new Date().toISOString(),
      lastProbeDate: today,
    }
    await kvPut(env, KV_KEYS.TIER_DATA, JSON.stringify(cleanTierStorage))
    await flushPendingWrites(env)
  } catch (err) {
    console.warn('[models] 重置梯队数据异常 (已静默降级):', err instanceof Error ? err.message : String(err))
  }

  return { totalReset, providerCount }
}

/**
 * 一键重置全局冷却模型 (兼容历史调用)
 * 只清除冷却状态 (cooldownUntil = null)，不修改永久失效标记 (permanentlyDisabled)，不清空失败计数 (failureCount)
 */
export async function resetAllCooldowns(env: Env): Promise<{ resetCount: number }> {
  const providers = await getProviders(env)
  let resetCount = 0

  const updatedProviders = providers.map((provider) => {
    let providerChanged = false
    const updatedModels = provider.models.map((model) => {
      if (model.cooldownUntil) {
        resetCount++
        providerChanged = true
        return {
          ...model,
          cooldownUntil: null, // 仅清除冷却状态
        }
      }
      return model
    })

    if (providerChanged) {
      return {
        ...provider,
        models: updatedModels,
        updatedAt: new Date().toISOString(),
      }
    }
    return provider
  })

  if (resetCount > 0) {
    await setProviders(env, updatedProviders)
  }

  return { resetCount }
}

/**
 * 识别上游返回的永久失效故障
 * 支持包含：模型不存在、已下架、余额不足/欠费
 */
export function detectPermanentFailure(status: number, errorMsg: string): string | null {
  if (!errorMsg) return null
  const lower = errorMsg.toLowerCase()

  // 1. 模型不存在 / 下架
  if (
    lower.includes('model_not_found') ||
    lower.includes('does not exist') ||
    lower.includes('not_supported') ||
    lower.includes('invalid_model') ||
    lower.includes('model_sunset') ||
    lower.includes('decommissioned') ||
    lower.includes('deprecated') ||
    lower.includes('模型不存在') ||
    lower.includes('已下架') ||
    lower.includes('模型已下架') ||
    (status === 404 && (lower.includes('model') || lower.includes('not found') || lower.includes('不存在')))
  ) {
    return '模型不存在或已下架'
  }

  // 2. 余额不足 / 欠费
  if (
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient_balance') ||
    lower.includes('quota_exceeded') ||
    lower.includes('out_of_credits') ||
    lower.includes('account_deactivated') ||
    lower.includes('billing') ||
    lower.includes('余额不足') ||
    lower.includes('欠费') ||
    lower.includes('点数不足') ||
    (status === 402 || (status === 429 && (lower.includes('quota') || lower.includes('balance') || lower.includes('insufficient'))))
  ) {
    return '账号余额不足或额度超限'
  }

  return null
}
