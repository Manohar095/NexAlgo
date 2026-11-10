import type {
  ApiResult,
  ListResult,
  StrategySymbolRow,
  SymbolSearchResult,
  SymbolSettings,
} from '@/types/strategy-symbols'
import { webClient } from './client'

const base = '/strategy-symbols/api'

/** Pull the server's message out of an Axios error. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const e = error as { response?: { data?: { message?: string } } }
  return e.response?.data?.message || fallback
}

export const strategySymbolsApi = {
  list: async (strategyId: string): Promise<ListResult> => {
    const r = await webClient.get<ListResult>(`${base}/${strategyId}/symbols`)
    return r.data
  },

  defaults: async (exchange: string): Promise<SymbolSettings> => {
    const r = await webClient.get<ApiResult<SymbolSettings>>(`${base}/defaults`, {
      params: { exchange },
    })
    return r.data.data as SymbolSettings
  },

  search: async (q: string, exchange?: string): Promise<SymbolSearchResult[]> => {
    const r = await webClient.get<ApiResult<SymbolSearchResult[]>>(`${base}/search`, {
      params: { q, exchange: exchange || undefined },
    })
    return r.data.data ?? []
  },

  create: async (
    strategyId: string,
    body: SymbolSettings & { symbol: string; exchange: string }
  ): Promise<ApiResult<StrategySymbolRow>> => {
    const r = await webClient.post<ApiResult<StrategySymbolRow>>(
      `${base}/${strategyId}/symbols`,
      body
    )
    return r.data
  },

  update: async (
    strategyId: string,
    id: number,
    body: SymbolSettings
  ): Promise<ApiResult<StrategySymbolRow>> => {
    const r = await webClient.put<ApiResult<StrategySymbolRow>>(
      `${base}/${strategyId}/symbols/${id}`,
      body
    )
    return r.data
  },

  remove: async (strategyId: string, id: number): Promise<ApiResult> => {
    const r = await webClient.delete<ApiResult>(`${base}/${strategyId}/symbols/${id}`)
    return r.data
  },

  setEnabled: async (strategyId: string, id: number, enabled: boolean): Promise<ApiResult> => {
    const r = await webClient.post<ApiResult>(
      `${base}/${strategyId}/symbols/${id}/${enabled ? 'enable' : 'disable'}`,
      {}
    )
    return r.data
  },

  command: async (strategyId: string, id: number, command: 'SQUAREOFF'): Promise<ApiResult> => {
    const r = await webClient.post<ApiResult>(`${base}/${strategyId}/symbols/${id}/command`, {
      command,
    })
    return r.data
  },
}
