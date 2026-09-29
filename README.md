<p align="center"><img src="build/icon.png" width="96" alt="Harmful"></p>

<h1 align="center">Harmful</h1>

<p align="center">Suas contas de jogos num só lugar: logins, senhas, nicks, ranks, skins e perfis.<br>Tudo num cofre <strong>criptografado e local</strong>, para Windows.</p>

---

## O que tem

- **Cofre criptografado:** AES-256-GCM com chave derivada da senha mestra (PBKDF2-SHA-256, 600 mil iterações). Os dados do cofre nunca saem do computador, e sem a senha mestra ninguém abre o cofre (nem nós).
- **Contas:** login, e-mail, senha (com gerador e medidor de força), 2FA, recuperação, telefone, jogos com nick e rank, tags, anotações e campos personalizados.
- **Minecraft:** skin em 3D (estilo NameMC) e capa da Mojang e do OptiFine, buscadas pelo nick e atualizadas sozinhas, inclusive quando o nick muda.
- **Steam:** foto, nome e nível do perfil público, com aviso de **VAC ban** e **trade ban**, atualizados sozinhos. Não precisa de chave de API.
- **Valorant (não oficial):** com a conta aberta no Riot Client, um clique lê rank, nível, VP, Radianita, loja do dia, mercado noturno e as skins que você comprou (sem as grátis e as de passe de batalha), com o **valor da conta em VP**. O card equipado vira a foto da conta. É só leitura e só da conta logada; o Harmful nunca vê a sua senha da Riot.
- **Segurança:** bloqueio automático quando o PC fica sem uso (jogar não conta como "parado"), bloqueio junto com o Windows (Win+L e suspensão), senha copiada apagada da área de transferência depois de alguns segundos e alerta de senhas repetidas ou fracas (dá para ignorar uma repetição de propósito, como em alts). Se o cofre bloquear no meio de uma edição, ela fica guardada (criptografada) e volta quando você desbloqueia.
- **Backup:** cópias automáticas no PC (e uma cópia extra antes de restaurar, importar ou trocar a senha mestra), cópia extra em outra pasta, backup manual e exportação em CSV. Se a cópia extra ficar no OneDrive ou no Google Drive, o arquivo criptografado vai para a nuvem, e ela nunca sobrescreve o backup de outro cofre na mesma pasta.
- **Atualização automática** pelas releases deste repositório.
- **Visual:** preto e roxo, minimalista, em lista ou grade, com ordem personalizada (arrastar ou Alt+setas).

## Atalhos

| Tecla | Ação |
|---|---|
| `/` ou `Ctrl+K` | Buscar |
| `Enter` na busca | Abrir a primeira conta |
| `Ctrl+Enter` na busca | Copiar a senha da primeira conta |
| `Shift+Enter` na busca | Copiar o login (ou e-mail) da primeira conta |
| `N` | Nova conta |
| `Alt+↑ ↓ ← →` | Mudar a conta de posição |
| `Ctrl+L` | Bloquear o cofre |

## O que o app acessa na internet

Só o necessário, e nunca nada do cofre:

- **Mojang e OptiFine:** skin e capa pelo nick/UUID do Minecraft.
- **Steam Community:** o perfil público pelo link ou SteamID.
- **Valorant, só quando você clica:** o Riot Client aberto no seu PC e os servidores da Riot com a sessão dele, mais o valorant-api.com para nomes e imagens das skins. Esse acesso não é oficial da Riot.
- **GitHub:** verificação de novas versões.

## Instalar

Baixe o `Harmful-Instalador-x.y.z.exe` da [última release](../../releases/latest). O app não é assinado digitalmente, então o Windows pode mostrar "O Windows protegeu o computador". Nesse caso, clique em **Mais informações** → **Executar assim mesmo**.

Depois disso ele se atualiza sozinho.

## Desenvolver

```bash
npm install
npm start          # abre o app
npm run dist       # gera o instalador em dist/
```

Feito com Electron. A interface é um único arquivo (`src/index.html`); o processo principal fica em `src/main.js`.

Fontes Mona Sans e Hubot Sans (GitHub) sob a SIL Open Font License 1.1 — ver `src/licenses/`.
