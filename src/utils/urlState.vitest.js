import { describe, it, expect, beforeEach } from 'vitest'
import {
  URL_PARAMS,
  ITEM_PANEL_STATE,
  readParam,
  readListParam,
  readBoolParam,
  syncUrlParam,
  pushUrlParam,
} from './urlState.js'

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('urlState registry + helpers', () => {
  it('exposes stable param names used across modules', () => {
    expect(URL_PARAMS.item).toBe('item')
    expect(URL_PARAMS.minHours).toBe('minHrs')
    expect(URL_PARAMS.hideAuction).toBe('hideAuction')
  })

  it('syncUrlParam sets, encodes booleans, and removes params in place', () => {
    syncUrlParam(URL_PARAMS.sort, 'price')
    expect(readParam(URL_PARAMS.sort)).toBe('price')

    syncUrlParam(URL_PARAMS.bestDeals, true)
    expect(readBoolParam(URL_PARAMS.bestDeals)).toBe(true)

    syncUrlParam(URL_PARAMS.sort, '')
    expect(readParam(URL_PARAMS.sort)).toBe(null)
  })

  it('reads and writes list params', () => {
    syncUrlParam(URL_PARAMS.hideAuction, ['a', 'b', 'c'])
    expect(readListParam(URL_PARAMS.hideAuction)).toEqual(['a', 'b', 'c'])
  })

  it('does not create a new history entry (replaceState)', () => {
    const before = window.history.length
    syncUrlParam(URL_PARAMS.sort, 'ending')
    expect(window.history.length).toBe(before)
  })

  it('pushUrlParam adds an entry and stamps the panel state marker', () => {
    pushUrlParam(URL_PARAMS.item, 'auction1:42', ITEM_PANEL_STATE)
    expect(readParam(URL_PARAMS.item)).toBe('auction1:42')
    expect(window.history.state?.goonersItemPanel).toBe(true)
  })
})
