import { describe, expect, it } from 'vitest'
import process from 'node:process'
import { StdioMcpClient } from '../../../src/runtime/mcp/stdio-mcp-client.js'

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
})
