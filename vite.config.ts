import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function licenseFile(): Plugin {
  const banner = /\/\*(?:!|\*?)(?:(?!\*\/)[\s\S])*?(?:@license|@preserve|^\s*!)(?:(?!\*\/)[\s\S])*\*\/\n?|\/\*!(?:(?!\*\/)[\s\S])*\*\/\n?/gm;
  const tidy = (text: string) => text.replace(/^\/\*+!?|\*+\/\s*$/g, '').split('\n').map((line) => line.replace(/^\s*\* ?/, '').trimEnd()).join('\n').trim();
  return {
    name: 'omniagent-license-file',
    apply: 'build',
    generateBundle(_options, bundle) {
      const notices = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        chunk.code = chunk.code.replace(banner, (match) => { notices.add(tidy(match)); return ''; });
      }
      if (notices.size) this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-LICENSES.txt', source: [...notices].join('\n\n---\n\n') + '\n' });
    }
  };
}

export default defineConfig({
  plugins: [react(), licenseFile()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/release/**', '**/dist-electron/**', '**/node_modules/**', '**/native/**', '**/build/**']
    }
  },
  build: {
    outDir: 'dist'
  },
  publicDir: 'public'
});
