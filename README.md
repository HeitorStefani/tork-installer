# Tork Automation

Instalador de terminal para provisionar Kanban, Chatwoot, n8n e Nginx Proxy Manager em VPS com Docker.

O objetivo e rodar um comando, abrir um menu visual no terminal e configurar uma VPS do zero, incluindo suporte a mais de um cliente na mesma VPS.

O dominio base padrao do assistente e `sistemasautomacao.store`. Para um cliente `clinica-a`, ele sugere automaticamente:

```text
kanban-clinica-a.sistemasautomacao.store
chatwoot-clinica-a.sistemasautomacao.store
n8n-clinica-a.sistemasautomacao.store
```

Em VPS com Nginx Proxy Manager ja instalado, use o modo de proxy compartilhado. O instalador conecta o proxy existente na rede do cliente e imprime as rotas internas, sem ocupar novas portas publicas no host.

## Uso rapido

Depois de hospedar este repositorio no GitHub:

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

Depois da instalacao:

```sh
tork-automation
```

## Desenvolvimento local

```sh
node tests/tork-cli-test.mjs
node tests/tork-package-test.mjs
node tests/tork-central-test.mjs
scripts/prepare-local-central.sh
```

## Documentacao

Veja [docs/TORK_AUTOMATION.md](docs/TORK_AUTOMATION.md).
