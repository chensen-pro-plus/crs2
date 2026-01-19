/**
 * 编辑器上下文解析器单元测试
 */

const {
  parseEditorContext,
  extractTextFromMessage,
  parseContextFromText,
  extractActiveDocument,
  extractCursorPosition,
  extractOtherDocuments,
  extractTerminalCommands,
  formatContextForLogging,
} = require('../src/utils/editorContextParser');

describe('editorContextParser', () => {
  
  // ==================== extractActiveDocument 测试 ====================
  describe('extractActiveDocument', () => {
    it('应该正确解析带语言类型的活跃文档', () => {
      const text = 'Active Document: /path/to/file.js (LANGUAGE_JAVASCRIPT)';
      const result = extractActiveDocument(text);
      
      expect(result).not.toBeNull();
      expect(result.path).toBe('/path/to/file.js');
      expect(result.language).toBe('LANGUAGE_JAVASCRIPT');
    });

    it('应该正确解析不带语言类型的活跃文档', () => {
      const text = 'Active Document: /path/to/file.txt';
      const result = extractActiveDocument(text);
      
      expect(result).not.toBeNull();
      expect(result.path).toBe('/path/to/file.txt');
      expect(result.language).toBeNull();
    });

    it('应该处理中文路径', () => {
      const text = 'Active Document: /Users/工作2/代理/file.js (LANGUAGE_JAVASCRIPT)';
      const result = extractActiveDocument(text);
      
      expect(result).not.toBeNull();
      expect(result.path).toBe('/Users/工作2/代理/file.js');
    });

    it('无活跃文档时应返回 null', () => {
      const text = 'Some other text without active document';
      const result = extractActiveDocument(text);
      
      expect(result).toBeNull();
    });
  });

  // ==================== extractCursorPosition 测试 ====================
  describe('extractCursorPosition', () => {
    it('应该正确解析 "Cursor is on line:" 格式', () => {
      const text = 'Cursor is on line: 42';
      const result = extractCursorPosition(text);
      
      expect(result).toBe(42);
    });

    it('应该正确解析 "Cursor Position:" 格式', () => {
      const text = 'Cursor Position: 123';
      const result = extractCursorPosition(text);
      
      expect(result).toBe(123);
    });

    it('无光标位置时应返回 null', () => {
      const text = 'Some text without cursor info';
      const result = extractCursorPosition(text);
      
      expect(result).toBeNull();
    });

    it('行号为 0 或负数时应返回 null', () => {
      const text = 'Cursor is on line: 0';
      const result = extractCursorPosition(text);
      
      expect(result).toBeNull();
    });
  });

  // ==================== extractOtherDocuments 测试 ====================
  describe('extractOtherDocuments', () => {
    it('应该正确解析其他打开的文档列表', () => {
      const text = `
Some context here
Other open documents:
- /path/to/file1.js (LANGUAGE_JAVASCRIPT)
- /path/to/file2.py (LANGUAGE_PYTHON)
- /path/to/file3.md

More text here
`;
      const result = extractOtherDocuments(text);
      
      expect(result).toHaveLength(3);
      expect(result[0].path).toBe('/path/to/file1.js');
      expect(result[0].language).toBe('LANGUAGE_JAVASCRIPT');
      expect(result[1].path).toBe('/path/to/file2.py');
      expect(result[2].path).toBe('/path/to/file3.md');
      expect(result[2].language).toBeNull();
    });

    it('无其他文档时应返回空数组', () => {
      const text = 'Active Document: /path/to/file.js';
      const result = extractOtherDocuments(text);
      
      expect(result).toEqual([]);
    });

    it('应该在遇到新标题时停止解析', () => {
      const text = `
Other open documents:
- /path/to/file1.js
Running terminal commands:
- npm run dev
`;
      const result = extractOtherDocuments(text);
      
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/path/to/file1.js');
    });
  });

  // ==================== extractTerminalCommands 测试 ====================
  describe('extractTerminalCommands', () => {
    it('应该正确解析终端命令列表', () => {
      const text = `
Running terminal commands:
- npm run dev
- node server.js
`;
      const result = extractTerminalCommands(text);
      
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('npm run dev');
      expect(result[1]).toBe('node server.js');
    });

    it('应该处理 "Running Terminal Commands:" 格式（大写）', () => {
      const text = `
Running Terminal Commands:
- npm test
`;
      const result = extractTerminalCommands(text);
      
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('npm test');
    });

    it('无终端命令时应返回空数组', () => {
      const text = 'Active Document: /path/to/file.js';
      const result = extractTerminalCommands(text);
      
      expect(result).toEqual([]);
    });
  });

  // ==================== extractTextFromMessage 测试 ====================
  describe('extractTextFromMessage', () => {
    it('应该从字符串 content 中提取文本', () => {
      const message = {
        role: 'user',
        content: 'Hello world'
      };
      const result = extractTextFromMessage(message);
      
      expect(result).toBe('Hello world');
    });

    it('应该从数组 content 中提取所有文本', () => {
      const message = {
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'image', data: 'base64...' },
          { type: 'text', text: 'Second part' }
        ]
      };
      const result = extractTextFromMessage(message);
      
      expect(result).toBe('First part\nSecond part');
    });

    it('空消息应返回空字符串', () => {
      expect(extractTextFromMessage(null)).toBe('');
      expect(extractTextFromMessage({})).toBe('');
      expect(extractTextFromMessage({ role: 'user' })).toBe('');
    });
  });

  // ==================== parseEditorContext 完整测试 ====================
  describe('parseEditorContext', () => {
    it('应该从完整的消息中解析所有上下文信息', () => {
      const messages = [
        {
          role: 'user',
          content: `
The user's current state is as follows:
Active Document: /Users/工作2/project/src/app.js (LANGUAGE_JAVASCRIPT)
Cursor is on line: 31
Other open documents:
- /Users/工作2/project/src/utils.js (LANGUAGE_JAVASCRIPT)
- /Users/工作2/project/package.json (LANGUAGE_JSON)
Running terminal commands:
- npm run dev

Please help me fix this bug.
`
        }
      ];
      
      const context = parseEditorContext(messages);
      
      expect(context.hasContext).toBe(true);
      expect(context.activeDocument).toBe('/Users/工作2/project/src/app.js');
      expect(context.language).toBe('LANGUAGE_JAVASCRIPT');
      expect(context.cursorLine).toBe(31);
      expect(context.otherDocuments).toHaveLength(2);
      expect(context.terminalCommands).toHaveLength(1);
      expect(context.terminalCommands[0]).toBe('npm run dev');
    });

    it('空消息数组应返回空上下文', () => {
      const context = parseEditorContext([]);
      
      expect(context.hasContext).toBe(false);
      expect(context.activeDocument).toBeNull();
      expect(context.cursorLine).toBeNull();
    });

    it('null 输入应返回空上下文', () => {
      const context = parseEditorContext(null);
      
      expect(context.hasContext).toBe(false);
    });

    it('应该忽略 assistant 角色的消息', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'Active Document: /should/be/ignored.js'
        },
        {
          role: 'user',
          content: 'Active Document: /real/file.js'
        }
      ];
      
      const context = parseEditorContext(messages);
      
      expect(context.activeDocument).toBe('/real/file.js');
    });

    it('应该使用后面消息的上下文（覆盖）', () => {
      const messages = [
        {
          role: 'user',
          content: 'Active Document: /first/file.js\nCursor is on line: 10'
        },
        {
          role: 'user',
          content: 'Active Document: /second/file.js\nCursor is on line: 20'
        }
      ];
      
      const context = parseEditorContext(messages);
      
      expect(context.activeDocument).toBe('/second/file.js');
      expect(context.cursorLine).toBe(20);
    });
  });

  // ==================== formatContextForLogging 测试 ====================
  describe('formatContextForLogging', () => {
    it('应该正确格式化完整上下文', () => {
      const context = {
        hasContext: true,
        activeDocument: '/path/to/file.js',
        language: 'LANGUAGE_JAVASCRIPT',
        cursorLine: 42,
        otherDocuments: [
          { path: '/path/to/other1.js', language: 'LANGUAGE_JAVASCRIPT' },
          { path: '/path/to/other2.js', language: 'LANGUAGE_JAVASCRIPT' }
        ],
        terminalCommands: ['npm run dev']
      };
      
      const result = formatContextForLogging(context);
      
      expect(result).toContain('[EditorContext]');
      expect(result).toContain('Active: file.js');
      expect(result).toContain('Line: 42');
      expect(result).toContain('Open: 2 files');
      expect(result).toContain('Terminal: 1 commands');
    });

    it('空上下文应返回 None', () => {
      const context = { hasContext: false };
      const result = formatContextForLogging(context);
      
      expect(result).toBe('[EditorContext] None');
    });

    it('null 上下文应返回 None', () => {
      const result = formatContextForLogging(null);
      
      expect(result).toBe('[EditorContext] None');
    });
  });

  // ==================== 边界情况测试 ====================
  describe('边界情况', () => {
    it('应该处理多行 Active Document（只取第一个）', () => {
      const text = `
Active Document: /first/file.js (LANGUAGE_JAVASCRIPT)
Some other content
Active Document: /second/file.js (LANGUAGE_JAVASCRIPT)
`;
      const result = extractActiveDocument(text);
      
      // match() 只返回第一个匹配
      expect(result.path).toBe('/first/file.js');
    });

    it('应该正确处理 Windows 风格路径', () => {
      // 注意：当前正则可能不完全支持 Windows 路径
      // 但基本的路径提取应该可以工作
      const text = 'Active Document: C:/Users/test/file.js';
      const result = extractActiveDocument(text);
      
      expect(result).not.toBeNull();
      expect(result.path).toBe('C:/Users/test/file.js');
    });

    it('应该处理特殊字符的文件名', () => {
      const text = 'Active Document: /path/to/file-name_v2.test.js (LANGUAGE_JAVASCRIPT)';
      const result = extractActiveDocument(text);
      
      expect(result.path).toBe('/path/to/file-name_v2.test.js');
    });
  });
});
