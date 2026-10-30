import { describe, expect, it } from 'vitest'
import { customHeaderPairs, fetchGatewayModelList } from '../src/runtimes/gateway-model-list.js'

describe('customHeaderPairs', () => {
  it('splits a pasted ANTHROPIC_CUSTOM_HEADERS block into the headers it names', () => {
    // A Cloudflare Access pair saved as one row with literal \n is the shape that lost the token.
    const pairs = customHeaderPairs({
      anthropic_custom_headers: 'CF-Access-Client-Id: abc\\nCF-Access-Client-Secret: def'
    })
    expect(pairs).toEqual({ 'CF-Access-Client-Id': 'abc', 'CF-Access-Client-Secret': 'def' })
  })

  it('splits real newlines the same way, since the console may send either', () => {
    expect(customHeaderPairs({ anthropic_custom_headers: 'a: 1\nb: 2' })).toEqual({ a: '1', b: '2' })
  })

  it('passes a plain header through untouched, including one whose value contains a colon', () => {
    expect(customHeaderPairs({ Authorization: 'Bearer sk-a:b', 'x-org': 'acme' })).toEqual({
      Authorization: 'Bearer sk-a:b',
      'x-org': 'acme'
    })
  })
})

describe('fetchGatewayModelList headers', () => {
  it('sends the deployment headers a gateway needs before it answers', async () => {
    let seen: Record<string, string> | undefined
    const spy = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await fetchGatewayModelList('https://gw.example/v1', 'tok', {
      fetchImpl: spy,
      headers: { 'CF-Access-Client-Id': 'abc' }
    })
    expect(seen).toEqual({ 'CF-Access-Client-Id': 'abc', Authorization: 'Bearer tok' })
  })
})
