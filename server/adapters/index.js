import { baSeAdapter } from './8se.js'
import { liuseAdapter } from './liuse.js'
import { qiguangjiAdapter } from './qiguangji.js'
import { xchinaAdapter } from './xchina.js'

export const adapters = [xchinaAdapter, liuseAdapter, baSeAdapter, qiguangjiAdapter]

export function listSources() {
  return adapters.map(({ capabilities, color, domains, id, name, status, version }) => ({
    capabilities,
    color,
    domains,
    id,
    name,
    status,
    version,
  }))
}

export function resolveAdapter(inputUrl, adapterId) {
  if (adapterId) {
    return adapters.find((adapter) => adapter.id === adapterId)
  }

  return adapters.find((adapter) => {
    try {
      return adapter.match(inputUrl)
    } catch {
      return false
    }
  })
}
