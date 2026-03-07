import { defineConfig } from 'changelogithub'

export default defineConfig({
  types: {
    feat: { title: '🚀 新功能' },
    fix: { title: '🐞 问题修复' },
    perf: { title: '🏎 性能优化' },
    chore: { title: '🧹 杂项' },
    style: { title: '🎨 样式' },
    refactor: { title: '🔨 重构' },
    docs: { title: '📚 文档' },
    ci: { title: '⚙️ CI/CD' },
  },
})
