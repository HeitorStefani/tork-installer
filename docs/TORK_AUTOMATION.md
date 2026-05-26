# Tork Automation

`tork-automation` e o instalador de terminal para transformar a stack em um produto instalavel.

## Objetivo

- Instalar Kanban, Chatwoot, n8n e proxy por menu de terminal.
- Validar uma chave de instalacao contra uma central.
- Renderizar arquivos Docker Compose com secrets locais.
- Permitir install, status, backup, restore, update e rollback pelo mesmo comando.
- Enviar heartbeat da VPS cliente para a central.

## Uso local

```sh
node cli/tork-automation.mjs version
node cli/tork-automation.mjs menu
node cli/tork-automation.mjs wizard
node cli/tork-automation.mjs install --yes --dryRun --full
node cli/tork-automation.mjs install --yes --dryRun --stack kanban
node cli/tork-automation.mjs embed-chatwoot --installDir /private/tmp/tork-cli-test --dryRun --proxyContainer nginx-proxy
node cli/tork-automation.mjs backup --installDir /private/tmp/tork-cli-test
node cli/tork-automation.mjs update --installDir /private/tmp/tork-cli-test --dryRun
node cli/tork-automation.mjs heartbeat --installDir /private/tmp/tork-cli-test --centralUrl http://127.0.0.1:8095 --key TORK-XXXX-XXXX --dryRun
```

Instalacao do comando:

```sh
sudo ./install.sh
tork-automation menu
```

Na VPS, a experiencia principal e:

```sh
tork-automation
```

Isso abre um painel no terminal com assistente de instalacao/configuracao. O caminho direto tambem existe:

```sh
tork-automation wizard
tork-automation new-client
```

Gerar pacote publico do instalador:

```sh
scripts/build-installer-package.sh
```

Isso cria `dist/install.sh`, `dist/install.sh.sha256`, `dist/tork-package.tgz` e `dist/tork-package.tgz.sha256`.

Preparar seu computador como central local, sem iniciar o servidor:

```sh
scripts/prepare-local-central.sh
```

Isso cria:

```text
central/start-local-central.sh
central/local-central.env
central/LOCAL_CENTRAL_READY.txt
central/data/admin-token.txt
dist/install.sh
dist/tork-package.tgz
```

Quando quiser iniciar manualmente:

```sh
central/start-local-central.sh
```

## Fluxo esperado em VPS de cliente

### Via GitHub

Depois que o repositorio estiver hospedado no GitHub, o bootstrap pode buscar o codigo direto de la:

```sh
curl -fsSL https://raw.githubusercontent.com/SUA_ORG/SEU_REPO/main/install.sh -o /tmp/tork-install.sh
TORK_GITHUB_REPO='SUA_ORG/SEU_REPO' \
TORK_GITHUB_REF='main' \
sh /tmp/tork-install.sh
```

Se o ambiente nao tiver `curl`, use `wget`:

```sh
wget -O /tmp/tork-install.sh https://raw.githubusercontent.com/SUA_ORG/SEU_REPO/main/install.sh
TORK_GITHUB_REPO='SUA_ORG/SEU_REPO' \
TORK_GITHUB_REF='main' \
sh /tmp/tork-install.sh
```

Esse comando instala dependencias, instala o `tork-automation` e abre o painel no terminal quando houver TTY. Para repositorio privado, informe `TORK_GITHUB_TOKEN`.

Evite `curl ... | sh` quando quiser abrir o menu visual automaticamente, porque o pipe ocupa o stdin do shell. Baixar o arquivo para `/tmp` e rodar `sh /tmp/tork-install.sh` preserva o terminal para o assistente.

Depois da primeira instalacao, o comando principal da VPS cliente fica:

```sh
tork-automation
```

Ele abre o painel visual com instalacao, configuracao, status, backup, update, rollback, heartbeat e comandos da central.

O dominio base padrao do assistente e `sistemasautomacao.store`. Para um cliente `clinica-a`, ele sugere:

```text
kanban-clinica-a.sistemasautomacao.store
chatwoot-clinica-a.sistemasautomacao.store
n8n-clinica-a.sistemasautomacao.store
```

## Mais de um cliente na mesma VPS

Use o menu:

```sh
tork-automation
```

Depois escolha:

```text
2. Configurar novo cliente nesta VPS
```

Esse caminho pede nome do cliente, ID curto, projeto Docker Compose, rede Docker isolada, dominio base, diretorio proprio, dominios e porta HTTP local do Kanban.

Em VPS que ja possui Nginx Proxy Manager rodando, use a opcao:

```text
Cliente completo: Chatwoot + n8n + Kanban, usando proxy existente
```

Nesse modo, o instalador nao sobe outro proxy e nao publica a porta do Kanban no host. Ele conecta o Nginx Proxy Manager existente na rede Docker do cliente e imprime os destinos internos para criar os Proxy Hosts:

```text
kanban-clinica-a.sistemasautomacao.store   -> http://clinica-a-kanban-frontend:80
chatwoot-clinica-a.sistemasautomacao.store -> http://clinica-a-chatwoot:3000
n8n-clinica-a.sistemasautomacao.store      -> http://clinica-a-n8n:5678
```

Para instalar direto sem passar pelo menu:

```sh
tork-automation install \
  --clientId clinica-a \
  --clientName "Clinica A" \
  --baseDomain sistemasautomacao.store \
  --installDir /opt/tork-automation/clients/clinica-a \
  --stack chatwoot,n8n,kanban \
  --kanbanHttpPort 8181 \
  --sharedProxy \
  --connectProxy \
  --yes
```

O instalador gera aliases unicos por cliente. No Nginx Proxy Manager, prefira apontar para os aliases com o ID do cliente:

```text
clinica-a-kanban-frontend : 80
clinica-a-chatwoot        : 3000
clinica-a-n8n             : 5678
```

Isso evita que dois clientes na mesma VPS disputem nomes internos como `chatwoot`, `n8n` ou `kanban-frontend`.

## Embed do Kanban no Chatwoot

Depois que a stack com Chatwoot e Kanban estiver de pe, aplique o embed pelo menu:

```text
7. Embedar Kanban no Chatwoot
```

Ou pelo comando direto:

```sh
tork-automation embed-chatwoot --installDir /opt/tork-automation
```

O comando:

- cria ou atualiza os Proxy Hosts no Nginx Proxy Manager;
- emite ou reutiliza um certificado Let's Encrypt para os dominios do cliente;
- injeta `https://DOMINIO_DO_KANBAN/dashboard-script.js` no HTML do Chatwoot;
- registra o resultado em `.tork-state.json`.

Se houver mais de um Nginx Proxy Manager na VPS, informe o container:

```sh
tork-automation embed-chatwoot \
  --installDir /opt/tork-automation/clients/clinica-a \
  --proxyContainer nginx-proxy
```

Para validar sem alterar o NPM:

```sh
tork-automation embed-chatwoot --installDir /opt/tork-automation --dryRun
```

### Via central/pacote

```sh
curl -fsSL https://central.torkautomation.com/install.sh -o install.sh && \
curl -fsSL https://central.torkautomation.com/install.sh.sha256 -o install.sh.sha256 && \
sha256sum -c install.sh.sha256 && \
TORK_INSTALL_KEY='TORK-XXXX-XXXX' \
TORK_CENTRAL_URL='https://central.torkautomation.com' \
TORK_PACKAGE_URL='https://central.torkautomation.com/tork-package.tgz' \
TORK_STACKS='full' \
sh install.sh
```

Se a central estiver rodando no seu computador, troque `https://central.torkautomation.com` pelo endereco publico/tunel do seu computador, por exemplo `https://seu-tunel.trycloudflare.com`.

Para auditar sem subir containers:

```sh
TORK_INSTALL_KEY='TORK-XXXX-XXXX' \
TORK_CENTRAL_URL='https://central.torkautomation.com' \
TORK_PACKAGE_URL='https://central.torkautomation.com/tork-package.tgz' \
TORK_DRY_RUN=1 \
sh install.sh
```

## Central de licencas

A primeira versao da central esta em:

```text
central/src/server.mjs
central/src/admin.mjs
central/src/store.mjs
central/src/manifest.mjs
```

Rodar central local:

```sh
export TORK_CENTRAL_ADMIN_TOKEN='troque-este-token'
export TORK_CENTRAL_HOST='0.0.0.0'
node central/src/server.mjs
```

Gerar chave de instalacao:

```sh
tork-automation central-create-key \
  --centralUrl http://127.0.0.1:8095 \
  --adminToken "$TORK_CENTRAL_ADMIN_TOKEN" \
  --customerId cliente-001 \
  --customerName "Cliente 001" \
  --features kanban,chatwoot,n8n,proxy \
  --maxUses 1
```

Listar clientes/chaves/instalacoes:

```sh
tork-automation central-list \
  --centralUrl http://127.0.0.1:8095 \
  --adminToken "$TORK_CENTRAL_ADMIN_TOKEN"
```

Revogar chave:

```sh
tork-automation central-revoke-key \
  --centralUrl http://127.0.0.1:8095 \
  --adminToken "$TORK_CENTRAL_ADMIN_TOKEN" \
  --id key_xxx
```

Usar a chave na VPS cliente:

```sh
tork-automation install \
  --key TORK-XXXX-XXXX-XXXX \
  --centralUrl https://central.torkautomation.com \
  --full
```

Rotas da central:

```http
GET  /health
GET  /install.sh
GET  /install.sh.sha256
GET  /tork-package.tgz
GET  /tork-package.tgz.sha256
GET  /api/installations/manifest
POST /api/installations/manifest
POST /api/installations/heartbeat
GET  /api/admin/install-keys
POST /api/admin/install-keys
POST /api/admin/install-keys/:id/revoke
```

Admin usa:

```http
Authorization: Bearer TORK_CENTRAL_ADMIN_TOKEN
```

Instalador usa:

```http
Authorization: Bearer TORK-XXXX-XXXX
```

## Comandos atuais

```sh
tork-automation menu
tork-automation new-client
tork-automation install --key CHAVE --centralUrl URL
tork-automation install --yes --manifest manifests/tork-stack.local.json --stack kanban
tork-automation status --installDir /opt/tork-automation
tork-automation backup --installDir /opt/tork-automation
tork-automation backup --installDir /opt/tork-automation --includeData
tork-automation restore --installDir /opt/tork-automation --file /opt/tork-automation/backups/backup.tar.gz --yes
tork-automation update --installDir /opt/tork-automation --key CHAVE --centralUrl URL
tork-automation rollback --installDir /opt/tork-automation --yes
tork-automation heartbeat --installDir /opt/tork-automation --key CHAVE --centralUrl URL
tork-automation central-create-key --centralUrl URL --adminToken TOKEN --customerId cliente-001
tork-automation central-list --centralUrl URL --adminToken TOKEN
tork-automation central-revoke-key --centralUrl URL --adminToken TOKEN --id key_xxx
tork-automation version
```

## Variaveis do bootstrap

O `install.sh` aceita:

- `TORK_INSTALL_KEY`: chave criada na central.
- `TORK_CENTRAL_URL`: URL da central.
- `TORK_PACKAGE_URL`: URL do `tork-package.tgz` publicado.
- `TORK_PACKAGE_SHA256_URL`: URL opcional do checksum do pacote. Se ausente, usa `TORK_PACKAGE_URL.sha256`.
- `TORK_GITHUB_REPO`: repositorio GitHub `org/repo` para baixar o codigo fonte via archive.
- `TORK_GITHUB_REF`: branch/tag/commit usado no GitHub, padrao `main`.
- `TORK_GITHUB_ARCHIVE_URL`: URL de archive customizada, se precisar.
- `TORK_GITHUB_TOKEN`: token opcional para repositorio privado.
- `TORK_REPO_URL`: alternativa para clonar um repositorio Git.
- `TORK_HOME` ou `TORK_INSTALL_DIR`: diretorio da instalacao, padrao `/opt/tork-automation`.
- `TORK_STACKS`: `full` ou lista separada por virgula, exemplo `kanban,chatwoot`.
- `TORK_DRY_RUN=1`: gera arquivos e mostra comandos sem subir Docker.
- `TORK_BOOTSTRAP_ONLY=1`: instala apenas o CLI.
- `TORK_SKIP_DEPENDENCIES=1`: nao instala Node/Docker, util para teste.
- `TORK_SKIP_STACK_INSTALL=1`: instala CLI mas nao roda a stack.
- `TORK_SEND_HEARTBEAT=0`: nao envia heartbeat inicial apos instalar.
- `TORK_OPEN_MENU=0`: nao abre o painel automaticamente ao final do bootstrap sem chave.
- `TORK_COMPOSE_VERSION`: versao do Docker Compose baixada quando o pacote `docker-compose-plugin` nao existe no apt.

O bootstrap valida o checksum do `tork-package.tgz` antes de extrair. O pacote publico inclui `backend` e `frontend` do Kanban para build local via Docker Compose, mas inclui apenas `central/src`, nunca `central/data`, token admin, `.env` local ou scripts locais da central.

## Flags multi-cliente

O comando `install` tambem aceita:

- `--clientId`: ID curto do cliente. Ele vira slug automaticamente, exemplo `Clinica A` vira `clinica-a`.
- `--clientName`: nome amigavel do cliente.
- `--baseDomain`: dominio base para gerar subdominios, padrao `sistemasautomacao.store`.
- `--projectName`: nome do projeto Docker Compose. Se ausente, usa `tork-CLIENTE`.
- `--network`: rede Docker. Se ausente para cliente novo, usa `tork-CLIENTE-infra`.
- `--kanbanHttpPort`: porta local do Kanban para evitar conflito entre clientes.
- `--sharedProxy`: nao publica porta do Kanban no host e prepara rotas internas para Nginx Proxy Manager existente.
- `--noExposePorts`: nao publica porta do Kanban, mesmo sem `--sharedProxy`.
- `--connectProxy`: tenta conectar um proxy existente na rede isolada do cliente.

## Backup, update e rollback

O fluxo recomendado para VPS de cliente e:

```sh
tork-automation backup --installDir /opt/tork-automation --includeData
tork-automation update --installDir /opt/tork-automation --key TORK-XXXX-XXXX --centralUrl https://central.torkautomation.com
```

O `update` ja cria um backup de configuracao antes de aplicar novos compose/images. Se uma atualizacao falhar, voltar para o ultimo backup:

```sh
tork-automation rollback --installDir /opt/tork-automation --yes
```

Para restaurar um arquivo especifico:

```sh
tork-automation restore \
  --installDir /opt/tork-automation \
  --file /opt/tork-automation/backups/tork-backup-ARQUIVO.tar.gz \
  --yes
```

Por padrao o backup salva configuracao, manifesto, `.env`, estado local e compose gerado. Use `--includeData` para incluir dumps dos Postgres do Kanban, Chatwoot e n8n. O restore de dados tambem exige `--includeData`, porque sobrescrever banco em producao e uma operacao sensivel.

## Heartbeat da VPS cliente

Depois da instalacao, a VPS cliente pode reportar status para a central:

```sh
tork-automation heartbeat \
  --installDir /opt/tork-automation \
  --key TORK-XXXX-XXXX \
  --centralUrl https://central.torkautomation.com
```

O payload enviado inclui:

- hostname, machine-id quando disponivel e diretorio de instalacao
- versao do CLI e versao do manifesto instalado
- stacks instaladas
- ultimo backup e ultimo update registrados
- containers do `docker compose ps`
- CPU load average, memoria, uptime e disco

Para testar sem Docker e sem enviar nada:

```sh
tork-automation heartbeat \
  --installDir /opt/tork-automation \
  --key TORK-XXXX-XXXX \
  --centralUrl https://central.torkautomation.com \
  --dryRun
```

Para enviar sem consultar Docker:

```sh
tork-automation heartbeat \
  --installDir /opt/tork-automation \
  --key TORK-XXXX-XXXX \
  --centralUrl https://central.torkautomation.com \
  --skipDocker
```

## Manifesto

O manifesto define:

- versao do produto
- features liberadas pela licenca
- imagens Docker
- defaults de dominio/porta
- templates de compose permitidos

Arquivo local de desenvolvimento:

```text
manifests/tork-stack.local.json
```

Na versao centralizada, a CLI busca:

```http
GET /api/installations/manifest
Authorization: Bearer TORK-XXXX-XXXX
```

Resposta esperada:

```json
{
  "schemaVersion": 1,
  "product": "tork-automation",
  "version": "0.1.0",
  "license": {
    "customerId": "cliente-123",
    "installationId": "inst-456",
    "features": ["kanban", "chatwoot", "n8n", "proxy"]
  },
  "images": {
    "kanbanBackend": "registry.example.com/tork/kanban-backend:1.0.0",
    "kanbanFrontend": "registry.example.com/tork/kanban-frontend:1.0.0"
  }
}
```

## Segurança aplicada no desenho

- A chave de instalacao nao entra no compose gerado.
- Secrets locais sao gerados na VPS cliente.
- `.env`, `manifest.json` e compose gerados sao gravados com permissao restrita.
- A central pode liberar imagens diferentes por cliente.
- O manifesto permite revogar recursos por feature.
- O comando tem `--dryRun` para auditar sem subir containers.
- Restore exige `--yes` fora de `--dryRun`, evitando sobrescrita acidental.
- Update cria backup antes de aplicar novas imagens, exceto se usar `--skipBackup`.
- Heartbeat usa a mesma chave de instalacao, mas a central permite chamadas repetidas da mesma VPS sem consumir novo uso.
- A central salva hash da chave, nao a chave em texto puro.
- A chave aparece em texto puro somente no momento da criacao.
- Chaves podem ter `maxUses`, expiracao e revogacao.
- A central registra instalacoes e eventos em `auditLog`.

## Proximos passos

1. Criar painel web para visualizar status das VPS clientes.
2. Integrar registry privado com imagens versionadas.
3. Assinar `install.sh` com checksum e, depois, assinatura criptografica.
4. Rodar teste real em VPS alvo com install, heartbeat, backup, update e rollback.
