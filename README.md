# Harmful

Organizador de contas de jogos para Windows: logins, senhas, nicks, ranks e skins do Minecraft em 3D (estilo NameMC), tudo num cofre **criptografado e local**.

- **Criptografia:** AES-256-GCM com chave derivada da senha mestra (PBKDF2-SHA-256, 600 mil iterações). Nada do cofre sai do computador.
- **Minecraft:** skin + capa (Mojang e OptiFine) buscadas pelo nick/UUID, atualizadas sozinhas.
- **Backup:** cópias automáticas locais e cópia extra criptografada em qualquer pasta (ex.: OneDrive/Google Drive).
- **Atualização automática** pelas releases deste repositório.

## Instalar

Baixe o `Harmful-Instalador-x.y.z.exe` da [última release](../../releases/latest). O app não é assinado digitalmente, então o Windows pode mostrar "O Windows protegeu o computador" → **Mais informações** → **Executar assim mesmo**.

## Desenvolver

```bash
npm install
npm start          # abre o app
npm run dist       # gera o instalador em dist/
```

Feito com Electron. A interface é um único arquivo (`src/index.html`); o processo principal fica em `src/main.js`.

Fontes Mona Sans e Hubot Sans (GitHub) sob a SIL Open Font License 1.1 — ver `src/licenses/`.
