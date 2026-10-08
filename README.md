# WhatsApp Business Evidence Generator

Ferramenta para gerar evidencias reais para o processo de **App Review da Meta**. Faz chamadas reais a API Graph do Meta e captura as respostas para criar um documento de evidencias formatado.

## Sobre

Este projeto ajuda desenvolvedores a submeter suas aplicacoes WhatsApp Business para revisao da Meta, oferecendo:

- **Modo de Geracao de Evidencias:** Executa chamadas reais a API Graph da Meta e captura respostas (status HTTP, trace IDs, request IDs, bodies) gerando um arquivo `.txt` de evidencias
- **Modo de Ativacao de Telefone:** Registra/ativa numeros de telefone na Cloud API da Meta usando o endpoint `/register`

### Permissoes Suportadas

| Permissao | Descricao |
|-----------|-----------|
| `whatsapp_business_messaging` | Envio e recebimento de mensagens WhatsApp |
| `whatsapp_business_management` | Gerenciamento de WABAs, templates, numeros de telefone e perfis comerciais |
| `business_management` | Operacoes do Business Manager |

## Tecnologias

Este e um projeto **100% frontend**, sem dependencias externas:

- **HTML5** - Estrutura single-page
- **CSS3** - Estilos modernos com custom properties e temas dark/light
- **JavaScript Vanilla** - Toda a logica da aplicacao
- **Fetch API** - Chamadas diretas a API Graph da Meta
- **LocalStorage** - Persistencia de configuracoes

**Nenhuma ferramenta de build necessaria** - Sem npm, webpack ou transpilers.

## Estrutura do Projeto

```
app-waba/
├── index.html    # Arquivo HTML principal com CSS embutido
├── app.js        # Logica JavaScript da aplicacao
└── README.md     # Este arquivo
```

## Como Usar

### Instalacao

Nenhuma instalacao necessaria - basta abrir o arquivo no navegador.

### Execucao

**Opcao 1:** Abrir diretamente no navegador
```bash
open index.html
```

**Opcao 2:** Servir com qualquer servidor estatico
```bash
# Usando Python
python -m http.server 8000

# Usando Node.js (npx)
npx serve .

# Usando PHP
php -S localhost:8000
```

Depois acesse `http://localhost:8000` no navegador.

> **Nota:** A aplicacao faz chamadas diretas para `graph.facebook.com` a partir do navegador. A API Graph da Meta permite isso atraves do header `Access-Control-Allow-Origin: *`.

## Funcionalidades

### Modo de Geracao de Evidencias

1. **Validacao de Token** - Testa access tokens contra a API Graph da Meta
2. **Auto-Discovery** - Descobre automaticamente App ID, WABA ID, Phone Number ID e Business ID a partir do token
3. **Suporte a Multiplas WABAs** - Interface de selecao quando ha multiplas WABAs disponiveis
4. **Construtor de Plano de Chamadas** - Monta um plano de chamadas API baseado nas permissoes selecionadas
5. **Execucao Real** - Faz chamadas reais para a API Graph (versoes v20.0 a v26.0)
6. **Geracao de Documento** - Cria arquivo `.txt` formatado com todas as evidencias

### Operacoes API Disponiveis

**whatsapp_business_management:**
- Ler detalhes da WABA
- Listar numeros de telefone
- Listar/criar/deletar templates de mensagem
- Ler/atualizar perfil comercial

**whatsapp_business_messaging:**
- Enviar mensagens com template
- Enviar mensagens de texto livre

**business_management:**
- Ler detalhes do business
- Listar WABAs owned/client
- Listar system users

### Modo de Ativacao de Telefone

- Busca de numeros de telefone em uma WABA
- Registro/ativacao de numeros na Cloud API com verificacao de PIN
- Mensagens de erro claras para erros comuns da API Meta

### Interface

- **Tema Dark/Light** - Alternancia de temas
- **Design Responsivo** - Funciona em desktop e mobile
- **Indicadores de Progresso** - Steps visuais
- **Filtragem em Tempo Real** - Filtra chamadas por status (2xx, erros, com trace ID)
- **Seguranca** - Campos sensíveis mascarados
- **Copiar/Baixar** - Exporta evidencias como `.txt`
- **Guia de Submissao** - Modal com templates e instrucoes para o App Review

## Configuracao

Toda configuracao e feita atraves da interface:

| Campo | Descricao |
|-------|-----------|
| Access Token | Token de System User ou Graph API Explorer |
| App ID | Entrada manual |
| WABA ID | Auto-descoberto ou manual |
| Phone Number ID | Auto-descoberto ou manual |
| Business ID | Auto-descoberto ou manual |
| Numero Destinatario | Formato E.164 (ex: +5511999999999) |
| Nome do Template | Nome do template de mensagem |
| Versao da API | v20.0 a v26.0 |

As configuracoes sao persistidas no **localStorage** com o prefixo `wabaEvid.`

## Formato das Evidencias

O arquivo `.txt` gerado segue um formato compativel com o processo de revisao da Meta:

```
╔══════════════════════════════════════════════════════════════════════╗
║                  EVIDÊNCIAS - META APP REVIEW                         ║
╠══════════════════════════════════════════════════════════════════════╣

APP ID:         123456789
WABA ID:        123456789
PHONE ID:       123456789
API VERSION:    v22.0
DATA/HORA:      2024-01-15 10:30:00 -03:00

──────────────────────────────────────────────────────────────────────

[1] GET /v22.0/123456789?fields=id,name,account_review_status...
    Status: 200 OK
    x-fb-trace-id: ABC123
    x-fb-request-id: DEF456
    
    curl -X GET "https://graph.facebook.com/v22.0/..."
    
    Response:
    {
      "id": "123456789",
      "name": "My WABA",
      ...
    }

═══════════════════════════════════════════════════════════════════════
```

## Compatibilidade

Funciona em navegadores modernos que suportam:
- ES6+ JavaScript
- Fetch API
- CSS Custom Properties
- Elemento `<dialog>`

Testado em: Chrome, Firefox, Safari, Edge

## Seguranca

- Tokens **nunca** sao enviados para nenhum servidor alem da API Graph da Meta
- Campos sensiveis sao mascarados por padrao
- O recurso "Lembrar token" armazena no localStorage (opcional)
- Arquivos de evidencia gerados mascaram tokens automaticamente

## Licenca

Este projeto e de uso interno/pessoal para auxiliar no processo de App Review da Meta.

## Links Uteis

- [Meta for Developers](https://developers.facebook.com/)
- [WhatsApp Business API Documentation](https://developers.facebook.com/docs/whatsapp)
- [App Review Process](https://developers.facebook.com/docs/app-review)
- [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
