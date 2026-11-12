// Ready-made connectors. Each one fills in the connector form; nothing is added until you save it.
// Remote servers speak MCP over HTTP. Programs run on this computer (npx needs Node.js, uvx needs uv).
// The gateways are the way to many apps at once: Zapier reaches thousands of apps, n8n runs your own workflows.
export const MCP_GROUPS=[
  ['start','Start from scratch'],
  ['gateway','Gateways to many apps'],
  ['signin','Sign in with your account'],
  ['token','With a token'],
  ['open','No account needed'],
  ['program','Programs on this computer']
];

export const MCP_CATALOG={
  custom:{group:'start',label:'Program on this computer',transport:'stdio',name:'',command:'',args:'',env:''},
  remote:{group:'start',label:'Server address (HTTP)',transport:'http',name:'',url:'https://',headers:'',note:'If the server asks for a sign-in, save it, then use Sign in on its card.'},
  openapi:{group:'start',label:'Web API with an OpenAPI description',transport:'openapi',name:'',spec:'https://',base:'',auth:'none',note:'Every operation in the description becomes a tool. Reading operations run freely, the rest ask first.'},

  zapier:{group:'gateway',label:'Zapier (thousands of apps)',transport:'http',name:'Zapier',url:'',headers:'',
    note:'Make an MCP server at mcp.zapier.com, choose the apps and actions residents may use, and paste its address here. The address holds a secret, so SILO keeps it in the vault and only shows it masked.'},
  n8n:{group:'gateway',label:'n8n (your own workflows)',transport:'http',name:'n8n',url:'https://YOUR-N8N-HOST/mcp/',headers:'',
    note:'Add an MCP Server Trigger to a workflow in n8n, attach the tools or workflows to it, and paste its production address. If you turned on authentication there, add the header here.'},

  notion:{group:'signin',label:'Notion',transport:'http',name:'Notion',url:'https://mcp.notion.com/mcp',headers:'',note:'Save it, then use Sign in on its card.'},
  linear:{group:'signin',label:'Linear',transport:'http',name:'Linear',url:'https://mcp.linear.app/mcp',headers:'',note:'Save it, then use Sign in on its card.'},
  sentry:{group:'signin',label:'Sentry',transport:'http',name:'Sentry',url:'https://mcp.sentry.dev/mcp',headers:'',note:'Save it, then use Sign in on its card.'},
  stripe:{group:'signin',label:'Stripe',transport:'http',name:'Stripe',url:'https://mcp.stripe.com',headers:'',note:'Save it, then use Sign in on its card. Payment actions always ask first unless you change that.'},

  github:{group:'token',label:'GitHub',transport:'http',name:'GitHub',url:'https://api.githubcopilot.com/mcp/',headers:'Authorization: Bearer YOUR_GITHUB_TOKEN',note:'Make a fine-grained personal access token on GitHub with only the repositories and rights you want.'},
  huggingface:{group:'token',label:'Hugging Face',transport:'http',name:'Hugging Face',url:'https://huggingface.co/mcp',headers:'Authorization: Bearer YOUR_HF_TOKEN',note:'Make a read token in your Hugging Face settings.'},

  mslearn:{group:'open',label:'Microsoft Learn docs',transport:'http',name:'Microsoft Learn',url:'https://learn.microsoft.com/api/mcp',headers:''},
  context7:{group:'open',label:'Context7 (library docs for code)',transport:'http',name:'Context7',url:'https://mcp.context7.com/mcp',headers:'',note:'Works without a key, with a lower limit. Add the header CONTEXT7_API_KEY for more.'},
  cfdocs:{group:'open',label:'Cloudflare docs',transport:'http',name:'Cloudflare docs',url:'https://docs.mcp.cloudflare.com/mcp',headers:''},

  filesystem:{group:'program',label:'Files in the workspace',transport:'stdio',name:'Files',command:'npx',args:'-y @modelcontextprotocol/server-filesystem .',env:''},
  memory:{group:'program',label:'Memory (a small knowledge graph)',transport:'stdio',name:'Memory',command:'npx',args:'-y @modelcontextprotocol/server-memory',env:''},
  thinking:{group:'program',label:'Sequential thinking',transport:'stdio',name:'Thinking',command:'npx',args:'-y @modelcontextprotocol/server-sequential-thinking',env:''},
  fetch:{group:'program',label:'Fetch web pages',transport:'stdio',name:'Fetch',command:'uvx',args:'mcp-server-fetch',env:''},
  git:{group:'program',label:'Git repository',transport:'stdio',name:'Git',command:'uvx',args:'mcp-server-git --repository .',env:''},
  time:{group:'program',label:'Time and time zones',transport:'stdio',name:'Time',command:'uvx',args:'mcp-server-time',env:''},
  sqlite:{group:'program',label:'SQLite database',transport:'stdio',name:'SQLite',command:'uvx',args:'mcp-server-sqlite --db-path silo.db',env:''},
  playwright:{group:'program',label:'Playwright browser',transport:'stdio',name:'Playwright',command:'npx',args:'@playwright/mcp@latest',env:''},
  stripelocal:{group:'program',label:'Stripe (secret key)',transport:'stdio',name:'Stripe',command:'npx',args:'-y @stripe/mcp --tools=all',env:'STRIPE_SECRET_KEY=YOUR_STRIPE_KEY',note:'Use a restricted key with only the rights residents need.'},
  notionlocal:{group:'program',label:'Notion (integration token)',transport:'stdio',name:'Notion',command:'npx',args:'-y @notionhq/notion-mcp-server',env:'NOTION_TOKEN=YOUR_NOTION_TOKEN'},
  brave:{group:'program',label:'Brave Search',transport:'stdio',name:'Brave Search',command:'npx',args:'-y @brave/brave-search-mcp-server',env:'BRAVE_API_KEY=YOUR_BRAVE_KEY'}
};
