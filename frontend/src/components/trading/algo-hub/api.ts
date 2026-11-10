import { webClient } from '@/api/client'
import type {
  AlgoSymbolRow,
  ApiResult,
  DefaultsResult,
  Overview,
  SymbolSearchResult,
  SymbolSettings,
} from './types'

const base = '/strategy-hub/api'

/** Pull the server's message out of an Axios error. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const e = error as { response?: { data?: { message?: string } } }
  return e.response?.data?.message || fallback
}

export const algoApi = {
  overview: async (): Promise<Overview> => {
    const r = await webClient.get<Overview>(`${base}/overview`)
    return r.data
  },

  defaults: async (exchange: string): Promise<DefaultsResult> => {
    const r = await webClient.get<DefaultsResult>(`${base}/defaults`, { params: { exchange } })
    return r.data
  },

  search: async (q: string, exchange?: string): Promise<SymbolSearchResult[]> => {
    const r = await webClient.get<ApiResult<SymbolSearchResult[]>>(`${base}/search`, {
      params: { q, exchange: exchange || undefined },
    })
    return r.data.data ?? []
  },

  create: async (
    body: SymbolSettings & { symbol: string; exchange: string }
  ): Promise<ApiResult<AlgoSymbolRow>> => {
    const r = await webClient.post<ApiResult<AlgoSymbolRow>>(`${base}/symbols`, body)
    return r.data
  },

  update: async (id: number, body: SymbolSettings): Promise<ApiResult<AlgoSymbolRow>> => {
    const r = await webClient.put<ApiResult<AlgoSymbolRow>>(`${base}/symbols/${id}`, body)
    return r.data
  },

  remove: async (id: number): Promise<ApiResult> => {
    const r = await webClient.delete<ApiResult>(`${base}/symbols/${id}`)
    return r.data
  },

  setEnabled: async (id: number, enabled: boolean): Promise<ApiResult> => {
    const r = await webClient.post<ApiResult>(
      `${base}/symbols/${id}/${enabled ? 'enable' : 'disable'}`,
      {}
    )
    return r.data
  },

  command: async (id: number, command: 'SQUAREOFF'): Promise<ApiResult> => {
    const r = await webClient.post<ApiResult>(`${base}/symbols/${id}/command`, { command })
    return r.data
  },

  process: async (exchange: string, action: 'start' | 'stop' | 'restart'): Promise<ApiResult> => {
    const r = await webClient.post<ApiResult>(`${base}/process/${exchange}/${action}`, {})
    return r.data
  },
}
