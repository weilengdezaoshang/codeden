import { describe, expect, it, vi } from 'vitest'
import process from 'node:process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StdioMcpClient } from '../../../packages/agent-runtime/src/mcp/stdio-mcp-client.js'
import { SseMcpClient } from '../../../packages/agent-runtime/src/mcp/sse-mcp-client.js'

describe('测试套件：StdioMcpClient', () => {
  it('验证：完成初始化、工具发现和工具调用', async () => {
    const script = [
      "const rl=require('readline').createInterface({input:process.stdin});",
      "rl.on('line',l=>{const r=JSON.parse(l);if(r.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'test',version:'1'}}}));",
      "else if(r.method==='tools/list') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{tools:[{name:'echo',description:'回显',inputSchema:{type:'object'}}]}}));",
      "else if(r.method==='tools/call') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:JSON.stringify(r.params.arguments)}]}}));});",
    ].join('')
    const client = new StdioMcpClient('test', {
      command: process.execPath,
      args: ['-e', script],
      timeoutMs: 2_000,
    })
    try {
      expect(await client.listTools()).toEqual([
        { name: 'echo', description: '回显', inputSchema: { type: 'object' } },
      ])
      expect(await client.callTool('echo', { ok: true })).toEqual({
        content: [{ type: 'text', text: '{"ok":true}' }],
      })
    } finally {
      await client.close()
    }
  })

  it('验证：并发连接只启动一个 MCP 服务进程', async () => {
    const markerDir = await mkdtemp(path.join(tmpdir(), 'codeden-mcp-'))
    const marker = path.join(markerDir, 'initialize-count')
    const script = [
      "const rl=require('readline').createInterface({input:process.stdin});",
      `const fs=require('fs');const marker=${JSON.stringify(marker)};`,
      "rl.on('line',l=>{const r=JSON.parse(l);if(r.method==='initialize'){fs.appendFileSync(marker,'1');console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{}}));}",
      "else if(r.method==='tools/list') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{tools:[]}}));});",
    ].join('')
    const client = new StdioMcpClient('concurrent', {
      command: process.execPath,
      args: ['-e', script],
      timeoutMs: 2_000,
    })

    try {
      const [first, second] = await Promise.all([client.listTools(), client.listTools()])
      expect(first).toEqual([])
      expect(second).toEqual([])
      expect(await readFile(marker, 'utf8')).toBe('1')
    } finally {
      await client.close()
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it('验证：服务进程异常退出后可以重新建立连接', async () => {
    const script = [
      "const rl=require('readline').createInterface({input:process.stdin});",
      "rl.on('line',l=>{const r=JSON.parse(l);if(r.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{}}));",
      "else if(r.method==='tools/list'){console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{tools:[]}}));setTimeout(()=>process.exit(0),20);}});",
    ].join('')
    const client = new StdioMcpClient('restart', {
      command: process.execPath,
      args: ['-e', script],
      timeoutMs: 2_000,
    })

    try {
      await expect(client.listTools()).resolves.toEqual([])
      await new Promise((resolve) => setTimeout(resolve, 100))
      await expect(client.listTools()).resolves.toEqual([])
    } finally {
      await client.close()
    }
  })

  it('验证：超大 MCP 响应会终止当前连接并快速失败', async () => {
    const script = "process.stdout.write('x'.repeat(2000001)+'\\n')"
    const client = new StdioMcpClient('oversized', {
      command: process.execPath,
      args: ['-e', script],
      timeoutMs: 2_000,
    })

    await expect(client.listTools()).rejects.toThrow('MCP response exceeded size limit')
    await expect(client.close()).resolves.toBeUndefined()
  })

  it('验证：通过 SSE 发现 endpoint 并完成工具调用', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const message = JSON.parse(String(init.body)) as {
          id?: number
          method?: string
          params?: { arguments?: unknown }
        }
        const result =
          message.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }] }
            : message.method === 'tools/call'
              ? { content: [{ type: 'text', text: JSON.stringify(message.params?.arguments) }] }
              : {}
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /messages\n\n'))
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SseMcpClient('sse-test', {
      url: 'https://mcp.example.com/sse',
      timeoutMs: 2_000,
    })

    try {
      await expect(client.listTools()).resolves.toEqual([
        { name: 'echo', description: '回显', inputSchema: { type: 'object' } },
      ])
      await expect(client.callTool('echo', { ok: true })).resolves.toEqual({
        content: [{ type: 'text', text: '{"ok":true}' }],
      })
    } finally {
      await client.close()
      vi.unstubAllGlobals()
    }
  })
})
