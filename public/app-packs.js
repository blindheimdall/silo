// Built-in apps: well-known web APIs with a small, useful set of operations each, ready to add with just a key.
// Each one becomes an OpenAPI connector (openapi-tools.mjs). Reading runs freely; anything that changes something
// asks first. The page and the server both read this file.
//
// An operation is [method, path, name, what it does, options]. Options:
//   q: query values, { name: 'description' } or { name: 'integer:description' } (also number, boolean, array)
//   body: what the JSON body holds, when there is one
//   read: true for a POST that only reads (a search), so it does not ask first
//   form: true when the body is sent as a form (Stripe, Twilio, Mailgun), not JSON
//   gql: 'read' for a GraphQL call that may only read (a mutation is refused)
// Path values in {braces} become required inputs.
// A pack can also have headers (sent with every call) and check: [operation, inputs], a harmless call SILO makes
// when you save the key, to show it works with your account. Without check, the first GET with no inputs is used.

export const APP_PACKS={
  // ----- Work and projects -----
  airtable:{name:'Airtable',group:'Work and projects',base:'https://api.airtable.com/v0',auth:{kind:'bearer'},key:'A personal access token from airtable.com/create/tokens with data.records:read, data.records:write and schema.bases:read, for the bases you choose.',ops:[
    ['GET','/meta/bases','list_bases','List the bases the token can use'],
    ['GET','/meta/bases/{baseId}/tables','list_tables','List the tables and fields of a base'],
    ['GET','/{baseId}/{table}','list_records','List records in a table (table name or id)',{q:{filterByFormula:'Airtable formula, like {Status}="Open"',maxRecords:'integer:How many at most',view:'View name or id'}}],
    ['GET','/{baseId}/{table}/{recordId}','get_record','Read one record'],
    ['POST','/{baseId}/{table}','create_records','Add records',{body:'{"records":[{"fields":{"Name":"..."}}]}, at most 10 records'}],
    ['PATCH','/{baseId}/{table}','update_records','Change fields of records',{body:'{"records":[{"id":"rec...","fields":{"Status":"Done"}}]}'}]]},
  asana:{name:'Asana',group:'Work and projects',base:'https://app.asana.com/api/1.0',auth:{kind:'bearer'},key:'A personal access token from app.asana.com/0/my-apps.',ops:[
    ['GET','/users/me','me','Who the token belongs to, with workspaces'],
    ['GET','/projects','list_projects','List projects',{q:{workspace:'Workspace gid',archived:'boolean:Archived ones'}}],
    ['GET','/tasks','list_tasks','List tasks of a project, or of a person in a workspace',{q:{project:'Project gid',assignee:'User gid or me (with workspace)',workspace:'Workspace gid',completed_since:'ISO date, or now for open tasks only',opt_fields:'Fields, like name,due_on,completed,assignee.name'}}],
    ['GET','/tasks/{task_gid}','get_task','Read a task'],
    ['POST','/tasks','create_task','Add a task',{body:'{"data":{"name":"...","notes":"...","projects":["gid"],"assignee":"gid or me","due_on":"2026-11-30"}}'}],
    ['PUT','/tasks/{task_gid}','update_task','Change a task, for example mark it done',{body:'{"data":{"completed":true}}'}],
    ['POST','/tasks/{task_gid}/stories','comment_task','Comment on a task',{body:'{"data":{"text":"..."}}'}]]},
  clickup:{name:'ClickUp',group:'Work and projects',base:'https://api.clickup.com/api/v2',auth:{kind:'header',name:'Authorization'},key:'Your personal API token (pk_...) from ClickUp settings, Apps.',ops:[
    ['GET','/team','list_workspaces','List workspaces (teams)'],
    ['GET','/team/{team_id}/space','list_spaces','List spaces in a workspace'],
    ['GET','/space/{space_id}/folder','list_folders','List folders in a space'],
    ['GET','/folder/{folder_id}/list','list_lists','List lists in a folder'],
    ['GET','/list/{list_id}/task','list_tasks','List tasks in a list',{q:{archived:'boolean:Archived ones',include_closed:'boolean:Closed ones too'}}],
    ['POST','/list/{list_id}/task','create_task','Add a task',{body:'{"name":"...","description":"...","status":"to do","due_date":1767225600000}'}],
    ['PUT','/task/{task_id}','update_task','Change a task',{body:'{"status":"complete"}'}],
    ['POST','/task/{task_id}/comment','comment_task','Comment on a task',{body:'{"comment_text":"..."}'}]]},
  jira:{name:'Jira',group:'Work and projects',base:'https://YOUR-SITE.atlassian.net/rest/api/3',auth:{kind:'basic'},key:'Your Atlassian email and an API token from id.atlassian.com/manage-profile/security/api-tokens, written as email:token. Put your site in the API address.',ops:[
    ['GET','/project/search','list_projects','List projects'],
    ['GET','/search/jql','search_issues','Find issues with JQL',{q:{jql:'JQL, like project = OPS AND status != Done',maxResults:'integer:How many at most',fields:'Fields, like summary,status,assignee'}}],
    ['GET','/issue/{issueIdOrKey}','get_issue','Read an issue'],
    ['POST','/issue','create_issue','Open an issue',{body:'{"fields":{"project":{"key":"OPS"},"summary":"...","issuetype":{"name":"Task"}}}'}],
    ['POST','/issue/{issueIdOrKey}/comment','comment_issue','Comment on an issue',{body:'{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"..."}]}]}}'}],
    ['GET','/issue/{issueIdOrKey}/transitions','list_transitions','The status changes an issue allows'],
    ['POST','/issue/{issueIdOrKey}/transitions','move_issue','Move an issue to another status',{body:'{"transition":{"id":"31"}}'}]]},
  confluence:{name:'Confluence',group:'Work and projects',base:'https://YOUR-SITE.atlassian.net/wiki/api/v2',auth:{kind:'basic'},key:'Your Atlassian email and an API token, written as email:token. Put your site in the API address.',ops:[
    ['GET','/spaces','list_spaces','List spaces'],
    ['GET','/pages','list_pages','List pages',{q:{'space-id':'Space id',title:'Exact title',limit:'integer:How many at most'}}],
    ['GET','/pages/{id}','get_page','Read a page',{q:{'body-format':'storage'}}],
    ['POST','/pages','create_page','Add a page',{body:'{"spaceId":"...","status":"current","title":"...","body":{"representation":"storage","value":"<p>...</p>"}}'}]]},
  trello:{name:'Trello',group:'Work and projects',base:'https://api.trello.com/1',auth:{kind:'query',name:'key,token'},key:'Your API key and a token from trello.com/power-ups/admin, written as key:token.',ops:[
    ['GET','/members/me/boards','list_boards','List your boards',{q:{fields:'name,url'}}],
    ['GET','/boards/{id}/lists','list_lists','List the lists on a board'],
    ['GET','/lists/{id}/cards','list_cards','List the cards in a list'],
    ['GET','/cards/{id}','get_card','Read a card'],
    ['POST','/cards','create_card','Add a card',{q:{idList:'List id',name:'Card title',desc:'Description',due:'ISO date'}}],
    ['PUT','/cards/{id}','update_card','Move or close a card',{q:{idList:'Move to this list',closed:'boolean:Archive it'}}],
    ['POST','/cards/{id}/actions/comments','comment_card','Comment on a card',{q:{text:'The comment'}}]]},
  todoist:{name:'Todoist',group:'Work and projects',base:'https://api.todoist.com/api/v1',auth:{kind:'bearer'},key:'Your API token from Todoist settings, Integrations, Developer.',ops:[
    ['GET','/projects','list_projects','List projects'],
    ['GET','/tasks','list_tasks','List open tasks',{q:{project_id:'Only this project'}}],
    ['POST','/tasks','create_task','Add a task',{body:'{"content":"...","due_string":"tomorrow at 10","project_id":"..."}'}],
    ['POST','/tasks/{id}/close','close_task','Mark a task done']]},
  smartsheet:{name:'Smartsheet',group:'Work and projects',base:'https://api.smartsheet.com/2.0',auth:{kind:'bearer'},key:'An API access token from Smartsheet, Personal settings, API access.',ops:[
    ['GET','/sheets','list_sheets','List sheets'],
    ['GET','/sheets/{sheetId}','get_sheet','Read a sheet with its columns and rows'],
    ['POST','/sheets/{sheetId}/rows','add_rows','Add rows',{body:'[{"toBottom":true,"cells":[{"columnId":123,"value":"..."}]}]'}]]},
  toggl:{name:'Toggl Track',group:'Work and projects',base:'https://api.track.toggl.com/api/v9',auth:{kind:'basic'},key:'Your API token from track.toggl.com/profile, written as TOKEN:api_token.',ops:[
    ['GET','/me','me','Your profile'],
    ['GET','/me/time_entries','list_time_entries','Your time entries',{q:{start_date:'ISO date',end_date:'ISO date'}}],
    ['GET','/me/time_entries/current','current_entry','What is running now']]},

  // ----- Sales and support -----
  hubspot:{name:'HubSpot',group:'Sales and support',base:'https://api.hubapi.com',auth:{kind:'bearer'},key:'A private app access token from HubSpot, Settings, Integrations, Private apps, with the CRM scopes you need.',ops:[
    ['GET','/crm/v3/objects/contacts','list_contacts','List contacts',{q:{limit:'integer:How many at most',properties:'Fields, like email,firstname,lastname',after:'Paging cursor'}}],
    ['POST','/crm/v3/objects/contacts/search','search_contacts','Find contacts',{body:'{"query":"ana@example.com","limit":10}',read:true}],
    ['POST','/crm/v3/objects/contacts','create_contact','Add a contact',{body:'{"properties":{"email":"...","firstname":"...","lastname":"..."}}'}],
    ['PATCH','/crm/v3/objects/contacts/{contactId}','update_contact','Change a contact',{body:'{"properties":{"lifecyclestage":"customer"}}'}],
    ['GET','/crm/v3/objects/deals','list_deals','List deals',{q:{limit:'integer:How many at most',properties:'Fields, like dealname,amount,dealstage'}}],
    ['POST','/crm/v3/objects/deals','create_deal','Add a deal',{body:'{"properties":{"dealname":"...","amount":"1200","dealstage":"appointmentscheduled"}}'}],
    ['GET','/crm/v3/objects/companies','list_companies','List companies',{q:{limit:'integer:How many at most'}}]]},
  pipedrive:{name:'Pipedrive',group:'Sales and support',base:'https://api.pipedrive.com/v1',auth:{kind:'query',name:'api_token'},key:'Your personal API token from Pipedrive, Personal preferences, API.',ops:[
    ['GET','/deals','list_deals','List deals',{q:{status:'open, won, lost or all_not_deleted',limit:'integer:How many at most'}}],
    ['GET','/deals/{id}','get_deal','Read a deal'],
    ['POST','/deals','create_deal','Add a deal',{body:'{"title":"...","value":1200,"currency":"EUR","person_id":1}'}],
    ['PUT','/deals/{id}','update_deal','Change a deal',{body:'{"status":"won"}'}],
    ['GET','/persons/search','search_persons','Find people',{q:{term:'Name, email or phone'}}],
    ['POST','/persons','create_person','Add a person',{body:'{"name":"...","email":["..."]}'}],
    ['POST','/notes','add_note','Add a note to a deal or person',{body:'{"content":"...","deal_id":1}'}]]},
  zendesk:{name:'Zendesk',group:'Sales and support',base:'https://YOUR-SUBDOMAIN.zendesk.com/api/v2',auth:{kind:'basic'},key:'Your agent email and an API token, written as you@example.com/token:YOUR_TOKEN. Put your subdomain in the API address.',ops:[
    ['GET','/tickets.json','list_tickets','List tickets',{q:{per_page:'integer:How many at most'}}],
    ['GET','/search.json','search','Search tickets, users and more',{q:{query:'Like type:ticket status:open printer'}}],
    ['GET','/tickets/{ticket_id}.json','get_ticket','Read a ticket'],
    ['GET','/tickets/{ticket_id}/comments.json','ticket_comments','Read the conversation of a ticket'],
    ['POST','/tickets.json','create_ticket','Open a ticket',{body:'{"ticket":{"subject":"...","comment":{"body":"..."},"priority":"normal"}}'}],
    ['PUT','/tickets/{ticket_id}.json','update_ticket','Answer or change a ticket',{body:'{"ticket":{"status":"solved","comment":{"body":"...","public":true}}}'}]]},
  freshdesk:{name:'Freshdesk',group:'Sales and support',base:'https://YOUR-DOMAIN.freshdesk.com/api/v2',auth:{kind:'basic'},key:'Your API key from your Freshdesk profile, written as YOUR_KEY:X. Put your domain in the API address.',ops:[
    ['GET','/tickets','list_tickets','List recent tickets',{q:{per_page:'integer:How many at most'}}],
    ['GET','/tickets/{id}','get_ticket','Read a ticket',{q:{include:'conversations'}}],
    ['POST','/tickets','create_ticket','Open a ticket',{body:'{"email":"...","subject":"...","description":"...","status":2,"priority":1}'}],
    ['POST','/tickets/{id}/reply','reply_ticket','Answer a ticket',{body:'{"body":"..."}'}],
    ['GET','/contacts','list_contacts','List contacts',{q:{email:'Only this email'}}]]},
  intercom:{name:'Intercom',group:'Sales and support',base:'https://api.intercom.io',auth:{kind:'bearer'},key:'An access token from the Intercom Developer Hub, your app, Authentication.',ops:[
    ['GET','/contacts','list_contacts','List contacts'],
    ['POST','/contacts/search','search_contacts','Find contacts',{body:'{"query":{"field":"email","operator":"=","value":"ana@example.com"}}',read:true}],
    ['GET','/conversations','list_conversations','List conversations'],
    ['GET','/conversations/{id}','get_conversation','Read a conversation'],
    ['POST','/conversations/{id}/reply','reply_conversation','Answer a conversation',{body:'{"message_type":"comment","type":"admin","admin_id":"...","body":"..."}'}]]},
  shopify:{name:'Shopify',group:'Sales and support',base:'https://YOUR-SHOP.myshopify.com/admin/api/2026-01',auth:{kind:'header',name:'X-Shopify-Access-Token'},key:'An Admin API access token from a custom app in your Shopify admin (Settings, Apps, Develop apps), with read access to orders, products and customers. Put your shop in the API address.',ops:[
    ['GET','/shop.json','shop','About the shop'],
    ['GET','/orders.json','list_orders','List orders',{q:{status:'open, closed, cancelled or any',limit:'integer:How many at most',created_at_min:'ISO date'}}],
    ['GET','/orders/{order_id}.json','get_order','Read an order'],
    ['GET','/products.json','list_products','List products',{q:{limit:'integer:How many at most',title:'Title contains'}}],
    ['GET','/customers/search.json','search_customers','Find customers',{q:{query:'Like email:ana@example.com'}}]]},

  // ----- Email and messages -----
  sendgrid:{name:'SendGrid',group:'Email and messages',base:'https://api.sendgrid.com/v3',auth:{kind:'bearer'},key:'An API key from SendGrid, Settings, API Keys, with Mail Send.',ops:[
    ['POST','/mail/send','send_email','Send an email',{body:'{"personalizations":[{"to":[{"email":"..."}]}],"from":{"email":"a verified sender"},"subject":"...","content":[{"type":"text/plain","value":"..."}]}'}],
    ['GET','/suppression/bounces','list_bounces','Addresses that bounced']]},
  resend:{name:'Resend',group:'Email and messages',base:'https://api.resend.com',auth:{kind:'bearer'},key:'An API key from resend.com/api-keys.',ops:[
    ['POST','/emails','send_email','Send an email',{body:'{"from":"You <you@your-domain>","to":["..."],"subject":"...","text":"..."}'}],
    ['GET','/emails/{id}','get_email','How a sent email is doing'],
    ['GET','/domains','list_domains','Your sending domains']]},
  brevo:{name:'Brevo',group:'Email and messages',base:'https://api.brevo.com/v3',auth:{kind:'header',name:'api-key'},key:'An API key from Brevo, SMTP and API, API keys.',ops:[
    ['POST','/smtp/email','send_email','Send an email',{body:'{"sender":{"email":"..."},"to":[{"email":"..."}],"subject":"...","textContent":"..."}'}],
    ['GET','/contacts','list_contacts','List contacts',{q:{limit:'integer:How many at most'}}],
    ['POST','/contacts','create_contact','Add a contact',{body:'{"email":"...","listIds":[2]}'}]]},
  mailchimp:{name:'Mailchimp',group:'Email and messages',base:'https://YOUR-DC.api.mailchimp.com/3.0',auth:{kind:'basic'},key:'An API key from Mailchimp, Profile, Extras, API keys, written as any:YOUR_KEY. The part after the dash in the key (like us21) goes in the API address.',ops:[
    ['GET','/lists','list_audiences','List audiences'],
    ['GET','/lists/{list_id}/members','list_members','List the people in an audience',{q:{count:'integer:How many at most',status:'subscribed, unsubscribed or cleaned'}}],
    ['POST','/lists/{list_id}/members','add_member','Add someone to an audience',{body:'{"email_address":"...","status":"subscribed"}'}],
    ['GET','/campaigns','list_campaigns','List campaigns',{q:{count:'integer:How many at most'}}]]},
  discord:{name:'Discord',group:'Email and messages',base:'https://discord.com/api/v10',auth:{kind:'header',name:'Authorization',prefix:'Bot '},key:'A bot token from discord.com/developers/applications, your app, Bot. Invite the bot to your server first.',ops:[
    ['GET','/users/@me/guilds','list_servers','The servers the bot is in'],
    ['GET','/guilds/{guild_id}/channels','list_channels','List the channels of a server'],
    ['GET','/channels/{channel_id}/messages','read_messages','Read recent messages',{q:{limit:'integer:How many, at most 100'}}],
    ['POST','/channels/{channel_id}/messages','send_message','Post a message',{body:'{"content":"..."}'}]]},

  // ----- Files, sites and content -----
  dropbox:{name:'Dropbox',group:'Files, sites and content',base:'https://api.dropboxapi.com/2',auth:{kind:'bearer'},key:'An access token from an app you make at dropbox.com/developers/apps, with files.metadata.read and sharing.write.',ops:[
    ['POST','/files/list_folder','list_folder','List a folder',{body:'{"path":"" for the top, or "/Folder"}',read:true}],
    ['POST','/files/search_v2','search','Find files',{body:'{"query":"invoice"}',read:true}],
    ['POST','/files/get_metadata','get_metadata','About one file or folder',{body:'{"path":"/Folder/file.pdf"}',read:true}],
    ['POST','/files/create_folder_v2','create_folder','Make a folder',{body:'{"path":"/New folder"}'}],
    ['POST','/sharing/create_shared_link_with_settings','share_link','Make a link to share a file',{body:'{"path":"/Folder/file.pdf"}'}]]},
  wordpress:{name:'WordPress',group:'Files, sites and content',base:'https://YOUR-SITE/wp-json/wp/v2',auth:{kind:'basic'},key:'Your user name and an application password (Users, Profile, Application passwords), written as user:password. Put your site in the API address.',ops:[
    ['GET','/posts','list_posts','List posts',{q:{search:'Words',status:'publish or draft',per_page:'integer:How many at most'}}],
    ['GET','/posts/{id}','get_post','Read a post'],
    ['POST','/posts','create_post','Write a post (a draft unless you say publish)',{body:'{"title":"...","content":"...","status":"draft"}'}],
    ['GET','/pages','list_pages','List pages',{q:{search:'Words'}}],
    ['GET','/comments','list_comments','List comments',{q:{post:'integer:Only on this post'}}]]},
  webflow:{name:'Webflow',group:'Files, sites and content',base:'https://api.webflow.com/v2',auth:{kind:'bearer'},key:'A site API token from Webflow, Site settings, Apps and integrations.',ops:[
    ['GET','/sites','list_sites','List sites'],
    ['GET','/sites/{site_id}/collections','list_collections','List the CMS collections of a site'],
    ['GET','/collections/{collection_id}/items','list_items','List the items of a collection'],
    ['POST','/collections/{collection_id}/items','create_item','Add an item (a draft)',{body:'{"isDraft":true,"fieldData":{"name":"...","slug":"..."}}'}]]},
  figma:{name:'Figma',group:'Files, sites and content',base:'https://api.figma.com/v1',auth:{kind:'header',name:'X-Figma-Token'},key:'A personal access token from Figma, Settings, Security.',ops:[
    ['GET','/me','me','Your account'],
    ['GET','/files/{file_key}','get_file','Read a file (the key is in its link)',{q:{depth:'integer:How deep, 1 or 2 for an overview'}}],
    ['GET','/files/{file_key}/comments','list_comments','Read the comments on a file'],
    ['POST','/files/{file_key}/comments','add_comment','Comment on a file',{body:'{"message":"..."}'}]]},
  calendly:{name:'Calendly',group:'Files, sites and content',base:'https://api.calendly.com',auth:{kind:'bearer'},key:'A personal access token from Calendly, Integrations, API and webhooks.',ops:[
    ['GET','/users/me','me','Your account, with your user address for the other calls'],
    ['GET','/event_types','list_event_types','Your kinds of meetings',{q:{user:'Your user address from me'}}],
    ['GET','/scheduled_events','list_events','Booked meetings',{q:{user:'Your user address from me',status:'active or canceled',min_start_time:'ISO date and time',count:'integer:How many at most'}}],
    ['GET','/scheduled_events/{uuid}/invitees','list_invitees','Who booked a meeting']]},
  typeform:{name:'Typeform',group:'Files, sites and content',base:'https://api.typeform.com',auth:{kind:'bearer'},key:'A personal access token from Typeform, Account, Personal tokens.',ops:[
    ['GET','/forms','list_forms','List forms'],
    ['GET','/forms/{form_id}','get_form','Read a form and its questions'],
    ['GET','/forms/{form_id}/responses','list_responses','Read answers',{q:{page_size:'integer:How many at most',since:'ISO date and time'}}]]},

  // ----- Code and servers -----
  gitlab:{name:'GitLab',group:'Code and servers',base:'https://gitlab.com/api/v4',auth:{kind:'header',name:'PRIVATE-TOKEN'},key:'A personal access token from GitLab, Preferences, Access tokens, with api or read_api. For your own GitLab, change the API address.',ops:[
    ['GET','/projects','list_projects','List projects',{q:{membership:'boolean:Only mine',search:'Words'}}],
    ['GET','/projects/{id}/issues','list_issues','List issues (id is a number or group/project)',{q:{state:'opened or closed',labels:'Labels, comma separated'}}],
    ['POST','/projects/{id}/issues','create_issue','Open an issue',{body:'{"title":"...","description":"..."}'}],
    ['POST','/projects/{id}/issues/{issue_iid}/notes','comment_issue','Comment on an issue',{body:'{"body":"..."}'}],
    ['GET','/projects/{id}/merge_requests','list_merge_requests','List merge requests',{q:{state:'opened, merged or closed'}}],
    ['GET','/projects/{id}/pipelines','list_pipelines','Recent pipelines',{q:{status:'failed, success or running'}}]]},
  bitbucket:{name:'Bitbucket',group:'Code and servers',base:'https://api.bitbucket.org/2.0',auth:{kind:'basic'},key:'Your Bitbucket user name and an API token or app password, written as user:token.',ops:[
    ['GET','/repositories/{workspace}','list_repositories','List repositories of a workspace'],
    ['GET','/repositories/{workspace}/{repo_slug}/pullrequests','list_pull_requests','List pull requests',{q:{state:'OPEN, MERGED or DECLINED'}}],
    ['GET','/repositories/{workspace}/{repo_slug}/commits','list_commits','Recent commits']]},
  sentry:{name:'Sentry API',group:'Code and servers',base:'https://sentry.io/api/0',auth:{kind:'bearer'},key:'An auth token from Sentry, Settings, Auth tokens, with project:read and event:write.',ops:[
    ['GET','/organizations/{organization_slug}/projects/','list_projects','List projects'],
    ['GET','/organizations/{organization_slug}/issues/','list_issues','List issues',{q:{query:'Like is:unresolved',statsPeriod:'Like 24h or 14d'}}],
    ['GET','/organizations/{organization_slug}/issues/{issue_id}/','get_issue','Read an issue'],
    ['PUT','/organizations/{organization_slug}/issues/{issue_id}/','update_issue','Resolve or ignore an issue',{body:'{"status":"resolved"}'}]]},
  pagerduty:{name:'PagerDuty',group:'Code and servers',base:'https://api.pagerduty.com',auth:{kind:'header',name:'Authorization',prefix:'Token token='},key:'A REST API key from PagerDuty, Integrations, API access keys (read only is enough).',ops:[
    ['GET','/incidents','list_incidents','List incidents',{q:{'statuses[]':'triggered, acknowledged or resolved',limit:'integer:How many at most'}}],
    ['GET','/incidents/{id}','get_incident','Read an incident'],
    ['GET','/oncalls','list_oncalls','Who is on call']]},
  cloudflare:{name:'Cloudflare',group:'Code and servers',base:'https://api.cloudflare.com/client/v4',auth:{kind:'bearer'},key:'An API token from dash.cloudflare.com/profile/api-tokens, with the zones and rights you choose.',ops:[
    ['GET','/zones','list_zones','List your domains'],
    ['GET','/zones/{zone_id}/dns_records','list_dns_records','List DNS records',{q:{name:'Only this name',type:'A, CNAME, TXT...'}}],
    ['POST','/zones/{zone_id}/dns_records','create_dns_record','Add a DNS record',{body:'{"type":"A","name":"www","content":"192.0.2.1","ttl":1,"proxied":true}'}],
    ['POST','/zones/{zone_id}/purge_cache','purge_cache','Empty the cache',{body:'{"purge_everything":true}'}]]},
  vercel:{name:'Vercel',group:'Code and servers',base:'https://api.vercel.com',auth:{kind:'bearer'},key:'A token from vercel.com/account/tokens.',ops:[
    ['GET','/v9/projects','list_projects','List projects'],
    ['GET','/v6/deployments','list_deployments','Recent deployments',{q:{projectId:'Only this project',limit:'integer:How many at most',state:'READY, ERROR or BUILDING'}}],
    ['GET','/v13/deployments/{idOrUrl}','get_deployment','Read a deployment']]},
  netlify:{name:'Netlify',group:'Code and servers',base:'https://api.netlify.com/api/v1',auth:{kind:'bearer'},key:'A personal access token from app.netlify.com/user/applications.',ops:[
    ['GET','/sites','list_sites','List sites'],
    ['GET','/sites/{site_id}/deploys','list_deploys','Recent deploys of a site'],
    ['POST','/sites/{site_id}/builds','start_build','Start a new build']]},
  digitalocean:{name:'DigitalOcean',group:'Code and servers',base:'https://api.digitalocean.com/v2',auth:{kind:'bearer'},key:'A personal access token from cloud.digitalocean.com/account/api/tokens.',ops:[
    ['GET','/account','account','Your account'],
    ['GET','/droplets','list_droplets','List droplets'],
    ['GET','/droplets/{droplet_id}','get_droplet','Read a droplet'],
    ['POST','/droplets/{droplet_id}/actions','droplet_action','Reboot, power off or power on a droplet',{body:'{"type":"reboot"}'}]]},

  // ----- Facts and news -----
  openmeteo:{name:'Open-Meteo weather',group:'Facts and news',base:'https://api.open-meteo.com/v1',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/forecast','forecast','Weather now and the next days for a place',{q:{latitude:'number:Latitude, like 44.43',longitude:'number:Longitude, like 26.10',current:'Like temperature_2m,wind_speed_10m,precipitation',daily:'Like temperature_2m_max,temperature_2m_min,precipitation_sum',timezone:'Like Europe/Bucharest or auto'}}]]},
  wikipedia:{name:'Wikipedia',group:'Facts and news',base:'https://en.wikipedia.org/api/rest_v1',auth:{kind:'none'},key:'No key needed. For another language, change en in the API address.',ops:[
    ['GET','/page/summary/{title}','summary','The summary of an article']]},
  hackernews:{name:'Hacker News',group:'Facts and news',base:'https://hacker-news.firebaseio.com/v0',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/topstories.json','top_stories','The ids of the top stories'],
    ['GET','/newstories.json','new_stories','The ids of the newest stories'],
    ['GET','/item/{id}.json','get_item','Read a story or comment']]},
  openweather:{name:'OpenWeather',group:'Facts and news',base:'https://api.openweathermap.org/data/2.5',auth:{kind:'query',name:'appid'},key:'An API key from home.openweathermap.org/api_keys.',ops:[
    ['GET','/weather','current','The weather now in a city',{q:{q:'City, like Bucharest,RO',units:'metric or imperial'}}],
    ['GET','/forecast','forecast','Five days, every three hours',{q:{q:'City, like Bucharest,RO',units:'metric or imperial'}}]]},
  newsapi:{name:'NewsAPI',group:'Facts and news',base:'https://newsapi.org/v2',auth:{kind:'header',name:'X-Api-Key'},key:'An API key from newsapi.org.',ops:[
    ['GET','/everything','search_news','Find articles',{q:{q:'Words',from:'ISO date',language:'Like en or ro',sortBy:'publishedAt, relevancy or popularity',pageSize:'integer:How many at most'}}],
    ['GET','/top-headlines','top_headlines','Top headlines',{q:{country:'Like us',category:'business, technology...',q:'Words'}}]]},
  youtube:{name:'YouTube search',group:'Facts and news',base:'https://www.googleapis.com/youtube/v3',auth:{kind:'query',name:'key'},key:'An API key from console.cloud.google.com with the YouTube Data API turned on.',ops:[
    ['GET','/search','search','Find videos',{q:{part:'snippet',q:'Words',type:'video',maxResults:'integer:How many at most',order:'relevance, date or viewCount'}}],
    ['GET','/videos','videos','Details of videos',{q:{part:'snippet,statistics',id:'Video ids, comma separated'}}]]},

  // ----- Payments and shops -----
  stripe:{name:'Stripe',group:'Payments and shops',base:'https://api.stripe.com/v1',auth:{kind:'bearer'},key:'A restricted key (rk_) or secret key (sk_) from dashboard.stripe.com/apikeys. A restricted key with only the rights you need is safer.',ops:[
    ['GET','/balance','balance','Your balance'],
    ['GET','/customers','list_customers','List customers',{q:{email:'Only this email',limit:'integer:How many at most'}}],
    ['GET','/customers/search','search_customers','Find customers',{q:{query:"Stripe search, like email:'ana@example.com'"}}],
    ['POST','/customers','create_customer','Add a customer',{form:true,body:'{"email":"...","name":"..."}'}],
    ['GET','/payment_intents','list_payments','Recent payments',{q:{customer:'Only this customer id',limit:'integer:How many at most'}}],
    ['GET','/invoices','list_invoices','List invoices',{q:{customer:'Customer id',status:'draft, open, paid, uncollectible or void',limit:'integer:How many at most'}}],
    ['GET','/subscriptions','list_subscriptions','List subscriptions',{q:{customer:'Customer id',status:'active, past_due, canceled or all',limit:'integer:How many at most'}}],
    ['GET','/products','list_products','List products',{q:{active:'boolean:Only active ones',limit:'integer:How many at most'}}],
    ['GET','/prices','list_prices','List prices',{q:{product:'Only this product',limit:'integer:How many at most'}}],
    ['POST','/payment_links','create_payment_link','Make a payment link',{form:true,body:'{"line_items":[{"price":"price_...","quantity":1}]}'}],
    ['POST','/refunds','refund','Refund a payment',{form:true,body:'{"payment_intent":"pi_...","amount":500} (amount in cents; leave it out to refund all)'}]]},
  square:{name:'Square',group:'Payments and shops',base:'https://connect.squareup.com/v2',auth:{kind:'bearer'},key:'A production access token from the Square Developer Dashboard, your app, Credentials.',ops:[
    ['GET','/locations','list_locations','List locations'],
    ['GET','/payments','list_payments','Recent payments',{q:{begin_time:'ISO date and time',location_id:'Location id',limit:'integer:How many at most'}}],
    ['GET','/customers','list_customers','List customers',{q:{limit:'integer:How many at most'}}],
    ['POST','/customers/search','search_customers','Find customers',{read:true,body:'{"query":{"filter":{"email_address":{"exact":"ana@example.com"}}}}'}],
    ['POST','/orders/search','search_orders','Find orders',{read:true,body:'{"location_ids":["..."],"limit":20}'}]]},
  woocommerce:{name:'WooCommerce',group:'Payments and shops',base:'https://YOUR-SITE/wp-json/wc/v3',auth:{kind:'basic'},key:'A REST API key from WooCommerce, Settings, Advanced, REST API, written as ck_...:cs_.... Put your site in the API address.',ops:[
    ['GET','/orders','list_orders','List orders',{q:{status:'pending, processing, completed or any',per_page:'integer:How many at most',after:'ISO date and time'}}],
    ['GET','/orders/{id}','get_order','Read an order'],
    ['PUT','/orders/{id}','update_order','Change an order, for example its status',{body:'{"status":"completed"}'}],
    ['POST','/orders/{id}/notes','add_order_note','Add a note to an order',{body:'{"note":"...","customer_note":false}'}],
    ['GET','/products','list_products','List products',{q:{search:'Words',per_page:'integer:How many at most'}}],
    ['GET','/customers','list_customers','List customers',{q:{email:'Only this email',per_page:'integer:How many at most'}}]]},
  lemonsqueezy:{name:'Lemon Squeezy',group:'Payments and shops',base:'https://api.lemonsqueezy.com/v1',auth:{kind:'bearer'},headers:{Accept:'application/vnd.api+json'},key:'An API key from Lemon Squeezy, Settings, API.',ops:[
    ['GET','/users/me','me','Your account'],
    ['GET','/stores','list_stores','List stores'],
    ['GET','/orders','list_orders','List orders',{q:{'filter[store_id]':'Store id','filter[user_email]':'Only this email'}}],
    ['GET','/subscriptions','list_subscriptions','List subscriptions',{q:{'filter[store_id]':'Store id','filter[status]':'active, cancelled, past_due...'}}],
    ['GET','/customers','list_customers','List customers',{q:{'filter[email]':'Only this email'}}]]},
  paddle:{name:'Paddle',group:'Payments and shops',base:'https://api.paddle.com',auth:{kind:'bearer'},key:'An API key from Paddle, Developer tools, Authentication.',ops:[
    ['GET','/transactions','list_transactions','List transactions',{q:{status:'completed, billed, past_due...',customer_id:'Customer id',per_page:'integer:How many at most'}}],
    ['GET','/subscriptions','list_subscriptions','List subscriptions',{q:{status:'active, past_due, paused or canceled',customer_id:'Customer id'}}],
    ['GET','/customers','list_customers','List customers',{q:{email:'Only this email',search:'Words'}}],
    ['GET','/products','list_products','List products',{q:{status:'active or archived'}}]]},

  // ----- More email and messages -----
  twilio:{name:'Twilio',group:'Email and messages',base:'https://api.twilio.com/2010-04-01',auth:{kind:'basic'},key:'Your Account SID and Auth Token from the Twilio Console, written as SID:TOKEN.',ops:[
    ['GET','/Accounts.json','list_accounts','Your account'],
    ['POST','/Accounts/{AccountSid}/Messages.json','send_sms','Send an SMS or WhatsApp message',{form:true,body:'{"To":"+40...","From":"your Twilio number","Body":"..."}'}],
    ['GET','/Accounts/{AccountSid}/Messages.json','list_messages','Recent messages',{q:{To:'Only to this number',From:'Only from this number',PageSize:'integer:How many at most'}}],
    ['GET','/Accounts/{AccountSid}/Calls.json','list_calls','Recent calls',{q:{To:'Only to this number',Status:'completed, busy, no-answer...',PageSize:'integer:How many at most'}}]]},
  mailgun:{name:'Mailgun',group:'Email and messages',base:'https://api.mailgun.net/v3',auth:{kind:'basic'},key:'Your Mailgun API key, written as api:YOUR_KEY. For the EU region put api.eu.mailgun.net in the API address.',ops:[
    ['GET','/domains','list_domains','Your sending domains'],
    ['POST','/{domain}/messages','send_email','Send an email',{form:true,body:'{"from":"You <you@your-domain>","to":"...","subject":"...","text":"..."}'}],
    ['GET','/{domain}/events','events','What happened to sent mail',{q:{event:'delivered, failed, opened...',limit:'integer:How many at most',begin:'Date, like Fri, 3 May 2026 09:00:00 -0000'}}]]},
  postmark:{name:'Postmark',group:'Email and messages',base:'https://api.postmarkapp.com',auth:{kind:'header',name:'X-Postmark-Server-Token'},key:'A server API token from Postmark, your server, API tokens.',ops:[
    ['GET','/server','server','About your server'],
    ['POST','/email','send_email','Send an email',{body:'{"From":"...","To":"...","Subject":"...","TextBody":"..."}'}],
    ['GET','/messages/outbound','list_sent','Sent mail',{q:{count:'integer:How many, like 50 (needed)',offset:'integer:Skip this many, like 0 (needed)',recipient:'Only to this address'}}],
    ['GET','/bounces','list_bounces','Bounces',{q:{count:'integer:How many, like 50 (needed)',offset:'integer:Skip this many, like 0 (needed)'}}]]},
  telegram:{name:'Telegram bot',group:'Email and messages',base:'https://api.telegram.org',auth:{kind:'path',prefix:'bot'},key:'A bot token from @BotFather. Use another bot than the SILO phone bot.',ops:[
    ['GET','/getMe','me','About the bot'],
    ['POST','/sendMessage','send_message','Send a message',{body:'{"chat_id":123456,"text":"..."}'}],
    ['GET','/getUpdates','updates','New messages to the bot',{q:{offset:'integer:The last update id plus one',limit:'integer:How many at most'}}],
    ['GET','/getChat','get_chat','About a chat',{q:{chat_id:'Chat id or @channel'}}]]},
  mailerlite:{name:'MailerLite',group:'Email and messages',base:'https://connect.mailerlite.com/api',auth:{kind:'bearer'},key:'An API token from MailerLite, Integrations, API.',ops:[
    ['GET','/subscribers','list_subscribers','List subscribers',{q:{'filter[status]':'active, unsubscribed, bounced...',limit:'integer:How many at most'}}],
    ['POST','/subscribers','add_subscriber','Add or update a subscriber',{body:'{"email":"...","groups":["group id"]}'}],
    ['GET','/groups','list_groups','List groups'],
    ['GET','/campaigns','list_campaigns','List campaigns',{q:{'filter[status]':'sent, draft or ready (needed)'}}]]},
  kit:{name:'Kit (ConvertKit)',group:'Email and messages',base:'https://api.kit.com/v4',auth:{kind:'header',name:'X-Kit-Api-Key'},key:'A v4 API key from Kit, Settings, Developer.',ops:[
    ['GET','/account','account','Your account'],
    ['GET','/subscribers','list_subscribers','List subscribers',{q:{email_address:'Only this email',status:'active, inactive, bounced...'}}],
    ['POST','/subscribers','add_subscriber','Add a subscriber',{body:'{"email_address":"...","first_name":"..."}'}],
    ['GET','/forms','list_forms','List forms'],
    ['GET','/tags','list_tags','List tags'],
    ['POST','/tags/{tag_id}/subscribers','tag_subscriber','Tag a subscriber',{body:'{"email_address":"..."}'}]]},

  // ----- More work and projects -----
  linear:{name:'Linear',group:'Work and projects',base:'https://api.linear.app',auth:{kind:'header',name:'Authorization'},key:'A personal API key from Linear, Settings, Security and access, Personal API keys.',check:['graphql_read',{body:{query:'{ viewer { id name } }'}}],ops:[
    ['POST','/graphql','graphql_read','Read with GraphQL, like { issues(first: 20) { nodes { identifier title state { name } assignee { name } } } } or { teams { nodes { id name } } }',{gql:'read',body:'{"query":"{ viewer { id name } }","variables":{}}'}],
    ['POST','/graphql','graphql_change','Change with a GraphQL mutation, like issueCreate or commentCreate',{body:'{"query":"mutation($t:String!,$team:String!){ issueCreate(input:{title:$t,teamId:$team}){ issue { identifier url } } }","variables":{"t":"...","team":"team id"}}'}]]},
  monday:{name:'monday.com',group:'Work and projects',base:'https://api.monday.com',auth:{kind:'header',name:'Authorization'},key:'A personal API token from monday.com, your avatar, Developers, My access tokens.',check:['graphql_read',{body:{query:'{ me { id name } }'}}],ops:[
    ['POST','/v2','graphql_read','Read with GraphQL, like { boards(limit: 10) { id name items_page(limit: 20) { items { id name } } } }',{gql:'read',body:'{"query":"{ boards(limit: 10) { id name } }"}'}],
    ['POST','/v2','graphql_change','Change with a GraphQL mutation, like create_item or change_column_value',{body:'{"query":"mutation { create_item(board_id: 123, item_name: \\"...\\") { id } }"}'}]]},
  coda:{name:'Coda',group:'Work and projects',base:'https://coda.io/apis/v1',auth:{kind:'bearer'},key:'An API token from coda.io/account, API settings.',ops:[
    ['GET','/whoami','me','Your account'],
    ['GET','/docs','list_docs','List docs',{q:{query:'Words in the name'}}],
    ['GET','/docs/{docId}/tables','list_tables','List the tables of a doc'],
    ['GET','/docs/{docId}/tables/{tableIdOrName}/rows','list_rows','Read rows',{q:{query:'Like "Status":"Open"',limit:'integer:How many at most',useColumnNames:'boolean:Names instead of ids'}}],
    ['POST','/docs/{docId}/tables/{tableIdOrName}/rows','add_rows','Add rows',{body:'{"rows":[{"cells":[{"column":"Name","value":"..."}]}]}'}]]},
  baserow:{name:'Baserow',group:'Work and projects',base:'https://api.baserow.io/api',auth:{kind:'header',name:'Authorization',prefix:'Token '},key:'A database token from Baserow, Settings, Database tokens. For your own Baserow, change the API address.',ops:[
    ['GET','/database/rows/table/{table_id}/','list_rows','Read rows of a table',{q:{user_field_names:'boolean:Use field names (say true)',search:'Words',size:'integer:How many at most'}}],
    ['POST','/database/rows/table/{table_id}/','add_row','Add a row',{q:{user_field_names:'boolean:Use field names (say true)'},body:'{"Name":"...","Status":"..."}'}],
    ['PATCH','/database/rows/table/{table_id}/{row_id}/','update_row','Change a row',{q:{user_field_names:'boolean:Use field names (say true)'},body:'{"Status":"Done"}'}]]},
  clockify:{name:'Clockify',group:'Work and projects',base:'https://api.clockify.me/api/v1',auth:{kind:'header',name:'X-Api-Key'},key:'An API key from Clockify, Profile settings, API.',ops:[
    ['GET','/user','me','Your profile, with your workspace'],
    ['GET','/workspaces','list_workspaces','List workspaces'],
    ['GET','/workspaces/{workspaceId}/projects','list_projects','List projects'],
    ['GET','/workspaces/{workspaceId}/user/{userId}/time-entries','list_time_entries','Time entries of a person',{q:{start:'ISO date and time',end:'ISO date and time'}}],
    ['POST','/workspaces/{workspaceId}/time-entries','add_time_entry','Add a time entry',{body:'{"start":"2026-11-09T09:00:00Z","end":"2026-11-09T10:30:00Z","description":"...","projectId":"..."}'}]]},
  harvest:{name:'Harvest',group:'Work and projects',base:'https://api.harvestapp.com/v2',auth:{kind:'header',name:'Authorization,Harvest-Account-Id',prefix:'Bearer '},key:'A personal access token and your account id from id.getharvest.com/developers, written as TOKEN:ACCOUNT_ID.',ops:[
    ['GET','/users/me','me','Your profile'],
    ['GET','/time_entries','list_time_entries','Time entries',{q:{from:'Date, like 2026-11-01',to:'Date',user_id:'integer:Only this person'}}],
    ['GET','/projects','list_projects','List projects',{q:{is_active:'boolean:Only active ones'}}],
    ['POST','/time_entries','add_time_entry','Add a time entry',{body:'{"project_id":1,"task_id":2,"spent_date":"2026-11-09","hours":1.5,"notes":"..."}'}]]},
  miro:{name:'Miro',group:'Work and projects',base:'https://api.miro.com/v2',auth:{kind:'bearer'},key:'An access token from a Miro app (miro.com/app/settings/user-profile/apps), installed on your team.',ops:[
    ['GET','/boards','list_boards','List boards',{q:{query:'Words in the name',limit:'integer:How many at most'}}],
    ['GET','/boards/{board_id}/items','list_items','Items on a board',{q:{type:'sticky_note, card, text, shape...',limit:'integer:How many at most'}}],
    ['POST','/boards/{board_id}/sticky_notes','add_sticky_note','Add a sticky note',{body:'{"data":{"content":"..."},"position":{"x":0,"y":0}}'}],
    ['POST','/boards','create_board','Make a board',{body:'{"name":"..."}'}]]},
  wrike:{name:'Wrike',group:'Work and projects',base:'https://www.wrike.com/api/v4',auth:{kind:'bearer'},key:'A permanent access token from Wrike, Apps and integrations, API.',check:['who_am_i',{me:true}],ops:[
    ['GET','/contacts','who_am_i','People, or yourself with me',{q:{me:'boolean:Only yourself'}}],
    ['GET','/folders','list_folders','Folders and projects'],
    ['GET','/tasks','list_tasks','Find tasks',{q:{title:'Words in the title',status:'Active, Completed...',limit:'integer:How many at most'}}],
    ['GET','/folders/{folderId}/tasks','folder_tasks','Tasks in a folder or project'],
    ['POST','/folders/{folderId}/tasks','create_task','Add a task',{q:{title:'Title',description:'Description'}}]]},

  // ----- More sales and support -----
  close:{name:'Close',group:'Sales and support',base:'https://api.close.com/api/v1',auth:{kind:'basic'},key:'An API key from Close, Settings, Developer, API keys, written as YOUR_KEY: (with the colon at the end).',ops:[
    ['GET','/me/','me','Your account'],
    ['GET','/lead/','list_leads','Find leads',{q:{query:'Close search, like name:acme',_limit:'integer:How many at most'}}],
    ['GET','/lead/{lead_id}/','get_lead','Read a lead'],
    ['POST','/lead/','create_lead','Add a lead',{body:'{"name":"Acme","contacts":[{"name":"...","emails":[{"email":"..."}]}]}'}],
    ['POST','/activity/note/','add_note','Add a note to a lead',{body:'{"lead_id":"lead_...","note":"..."}'}],
    ['GET','/opportunity/','list_opportunities','List opportunities',{q:{status_type:'active, won or lost',_limit:'integer:How many at most'}}]]},
  front:{name:'Front',group:'Sales and support',base:'https://api2.frontapp.com',auth:{kind:'bearer'},key:'An API token from Front, Settings, Developers, API tokens.',ops:[
    ['GET','/me','me','Your account'],
    ['GET','/inboxes','list_inboxes','List inboxes'],
    ['GET','/conversations','list_conversations','Recent conversations',{q:{q:'Like q[statuses][]=unassigned',limit:'integer:How many at most'}}],
    ['GET','/conversations/{conversation_id}','get_conversation','Read a conversation'],
    ['GET','/conversations/{conversation_id}/messages','list_messages','The messages of a conversation'],
    ['POST','/conversations/{conversation_id}/comments','add_comment','Leave an internal comment',{body:'{"body":"..."}'}]]},
  attio:{name:'Attio',group:'Sales and support',base:'https://api.attio.com/v2',auth:{kind:'bearer'},key:'An access token from Attio, Workspace settings, Developers.',ops:[
    ['GET','/self','me','About the token'],
    ['GET','/objects','list_objects','The kinds of records (people, companies, deals...)'],
    ['POST','/objects/{object}/records/query','find_records','Find records',{read:true,body:'{"filter":{"name":"Acme"},"limit":20}'}],
    ['POST','/objects/{object}/records','create_record','Add a record',{body:'{"data":{"values":{"name":"..."}}}'}],
    ['POST','/notes','add_note','Add a note to a record',{body:'{"data":{"parent_object":"people","parent_record_id":"...","title":"...","format":"plaintext","content":"..."}}'}]]},

  // ----- More code and servers -----
  render:{name:'Render',group:'Code and servers',base:'https://api.render.com/v1',auth:{kind:'bearer'},key:'An API key from dashboard.render.com, Account settings, API keys.',ops:[
    ['GET','/services','list_services','List services',{q:{limit:'integer:How many at most'}}],
    ['GET','/services/{serviceId}/deploys','list_deploys','Recent deploys',{q:{limit:'integer:How many at most'}}],
    ['POST','/services/{serviceId}/deploys','deploy','Start a deploy',{body:'{}'}],
    ['POST','/services/{serviceId}/restart','restart','Restart a service']]},
  heroku:{name:'Heroku',group:'Code and servers',base:'https://api.heroku.com',auth:{kind:'bearer'},headers:{Accept:'application/vnd.heroku+json; version=3'},key:'An API key from dashboard.heroku.com/account, or heroku authorizations:create.',ops:[
    ['GET','/account','account','Your account'],
    ['GET','/apps','list_apps','List apps'],
    ['GET','/apps/{app}/releases','list_releases','Releases of an app'],
    ['GET','/apps/{app}/dynos','list_dynos','Dynos of an app'],
    ['DELETE','/apps/{app}/dynos','restart_all','Restart all dynos of an app']]},
  fly:{name:'Fly.io',group:'Code and servers',base:'https://api.machines.dev/v1',auth:{kind:'bearer'},key:'A token from fly tokens create org, or fly.io/dashboard, Tokens.',check:['list_apps',{org_slug:'personal'}],ops:[
    ['GET','/apps','list_apps','List apps',{q:{org_slug:'Your organization, like personal'}}],
    ['GET','/apps/{app_name}/machines','list_machines','Machines of an app'],
    ['POST','/apps/{app_name}/machines/{machine_id}/restart','restart_machine','Restart a machine'],
    ['POST','/apps/{app_name}/machines/{machine_id}/stop','stop_machine','Stop a machine']]},
  supabase:{name:'Supabase',group:'Code and servers',base:'https://api.supabase.com/v1',auth:{kind:'bearer'},key:'A personal access token from supabase.com/dashboard/account/tokens.',ops:[
    ['GET','/projects','list_projects','List projects'],
    ['GET','/projects/{ref}/functions','list_functions','Edge functions of a project'],
    ['POST','/projects/{ref}/database/query','run_sql','Run SQL on the database (asks first)',{body:'{"query":"select count(*) from orders"}'}]]},
  neon:{name:'Neon',group:'Code and servers',base:'https://console.neon.tech/api/v2',auth:{kind:'bearer'},key:'An API key from console.neon.tech, Account settings, API keys.',ops:[
    ['GET','/projects','list_projects','List projects'],
    ['GET','/projects/{project_id}/branches','list_branches','Branches of a project'],
    ['POST','/projects/{project_id}/branches','create_branch','Make a branch',{body:'{"branch":{"name":"..."}}'}],
    ['GET','/projects/{project_id}/operations','list_operations','Recent operations']]},
  betterstack:{name:'Better Stack Uptime',group:'Code and servers',base:'https://uptime.betterstack.com/api/v2',auth:{kind:'bearer'},key:'An API token from Better Stack, Settings, API tokens (Uptime).',ops:[
    ['GET','/monitors','list_monitors','List monitors'],
    ['GET','/monitors/{monitor_id}','get_monitor','Read a monitor'],
    ['GET','/incidents','list_incidents','List incidents',{q:{from:'Date, like 2026-11-01',to:'Date'}}],
    ['POST','/monitors','create_monitor','Watch a new address',{body:'{"url":"https://...","monitor_type":"status","check_frequency":180}'}]]},
  datadog:{name:'Datadog',group:'Code and servers',base:'https://api.datadoghq.com',auth:{kind:'header',name:'DD-API-KEY,DD-APPLICATION-KEY'},key:'An API key and an application key from Datadog, Organization settings, written as API_KEY:APP_KEY. For the EU site put api.datadoghq.eu in the API address.',ops:[
    ['GET','/api/v1/validate','validate','Check the API key'],
    ['GET','/api/v1/monitor','list_monitors','List monitors',{q:{name:'Words in the name',monitor_tags:'Tags, comma separated'}}],
    ['POST','/api/v2/logs/events/search','search_logs','Find logs',{read:true,body:'{"filter":{"query":"service:web status:error","from":"now-1h","to":"now"},"page":{"limit":20}}'}],
    ['POST','/api/v1/events','post_event','Post an event',{body:'{"title":"...","text":"...","tags":["silo"]}'}]]},
  opsgenie:{name:'Opsgenie',group:'Code and servers',base:'https://api.opsgenie.com/v2',auth:{kind:'header',name:'Authorization',prefix:'GenieKey '},key:'An API key from an Opsgenie API integration (Settings, Integrations). For the EU put api.eu.opsgenie.com in the API address.',ops:[
    ['GET','/alerts','list_alerts','List alerts',{q:{query:'Like status:open',limit:'integer:How many at most'}}],
    ['POST','/alerts','create_alert','Raise an alert',{body:'{"message":"...","priority":"P3","description":"..."}'}],
    ['POST','/alerts/{identifier}/acknowledge','acknowledge_alert','Acknowledge an alert',{body:'{}'}],
    ['POST','/alerts/{identifier}/close','close_alert','Close an alert',{body:'{}'}]]},
  statuspage:{name:'Statuspage',group:'Code and servers',base:'https://api.statuspage.io/v1',auth:{kind:'header',name:'Authorization',prefix:'OAuth '},key:'An API key from Statuspage, your avatar, API info.',ops:[
    ['GET','/pages','list_pages','List status pages'],
    ['GET','/pages/{page_id}/components','list_components','Components of a page'],
    ['GET','/pages/{page_id}/incidents','list_incidents','Incidents of a page'],
    ['POST','/pages/{page_id}/incidents','create_incident','Post an incident',{body:'{"incident":{"name":"...","status":"investigating","body":"..."}}'}]]},
  algolia:{name:'Algolia',group:'Code and servers',base:'https://YOUR-APP-ID.algolia.net/1',auth:{kind:'header',name:'X-Algolia-Application-Id,X-Algolia-API-Key'},key:'Your application id and an API key from Algolia, Settings, API keys, written as APP_ID:KEY. Put the application id in the API address too.',ops:[
    ['GET','/indexes','list_indexes','List indexes'],
    ['POST','/indexes/{indexName}/query','search','Search an index',{read:true,body:'{"query":"...","hitsPerPage":10}'}],
    ['GET','/indexes/{indexName}/{objectID}','get_record','Read a record'],
    ['POST','/indexes/{indexName}','add_record','Add a record',{body:'{"objectID":"...","name":"..."}'}]]},

  // ----- AI and data -----
  deepl:{name:'DeepL',group:'AI and data',base:'https://api-free.deepl.com/v2',auth:{kind:'header',name:'Authorization',prefix:'DeepL-Auth-Key '},key:'An authentication key from deepl.com/your-account/keys. For a Pro key put api.deepl.com in the API address.',ops:[
    ['GET','/usage','usage','How much of your quota is used'],
    ['POST','/translate','translate','Translate text',{body:'{"text":["..."],"target_lang":"RO"}'}],
    ['GET','/languages','languages','Languages',{q:{type:'source or target'}}]]},
  replicate:{name:'Replicate',group:'AI and data',base:'https://api.replicate.com/v1',auth:{kind:'bearer'},key:'An API token from replicate.com/account/api-tokens. Runs cost money on your account.',ops:[
    ['GET','/account','account','Your account'],
    ['POST','/models/{owner}/{name}/predictions','run_model','Run a model (costs money, asks first)',{body:'{"input":{"prompt":"..."}}'}],
    ['GET','/predictions/{id}','get_prediction','How a run is doing, and its result'],
    ['GET','/predictions','list_predictions','Recent runs']]},
  plausible:{name:'Plausible Analytics',group:'AI and data',base:'https://plausible.io/api/v2',auth:{kind:'bearer'},key:'A Stats API key from Plausible, Account settings, API keys.',ops:[
    ['POST','/query','stats','Visitors and pages for a site',{read:true,body:'{"site_id":"example.com","metrics":["visitors","pageviews"],"date_range":"7d","dimensions":["event:page"]}'}]]},
  posthog:{name:'PostHog',group:'AI and data',base:'https://us.posthog.com/api',auth:{kind:'bearer'},key:'A personal API key from PostHog, Settings, Personal API keys. For the EU cloud put eu.posthog.com in the API address.',ops:[
    ['GET','/users/@me/','me','Your account'],
    ['GET','/projects/','list_projects','List projects'],
    ['POST','/projects/{project_id}/query/','query','Ask with HogQL',{read:true,body:'{"query":{"kind":"HogQLQuery","query":"select event, count() from events where timestamp > now() - interval 1 day group by event order by 2 desc limit 20"}}'}],
    ['GET','/projects/{project_id}/insights/','list_insights','Saved insights']]},
  cloudinary:{name:'Cloudinary',group:'Files, sites and content',base:'https://api.cloudinary.com/v1_1/YOUR-CLOUD',auth:{kind:'basic'},key:'Your API key and secret from the Cloudinary console, written as KEY:SECRET. Put your cloud name in the API address.',ops:[
    ['GET','/usage','usage','Your plan and use'],
    ['GET','/resources/image','list_images','List images',{q:{max_results:'integer:How many at most',prefix:'Only in this folder'}}],
    ['POST','/resources/search','search','Find files',{read:true,body:'{"expression":"folder:products AND tags:new","max_results":20}'}]]},
  contentful:{name:'Contentful',group:'Files, sites and content',base:'https://cdn.contentful.com/spaces/YOUR-SPACE/environments/master',auth:{kind:'bearer'},key:'A Content Delivery API token from Contentful, Settings, API keys. Put your space id in the API address.',ops:[
    ['GET','/content_types','list_content_types','The kinds of content'],
    ['GET','/entries','list_entries','Find entries',{q:{content_type:'Only this kind',query:'Words',limit:'integer:How many at most'}}],
    ['GET','/entries/{entry_id}','get_entry','Read an entry']]},
  ghost:{name:'Ghost',group:'Files, sites and content',base:'https://YOUR-SITE/ghost/api/content',auth:{kind:'query',name:'key'},key:'A Content API key from Ghost, Settings, Integrations, a custom integration. Put your site in the API address.',ops:[
    ['GET','/posts/','list_posts','List posts',{q:{limit:'integer:How many at most',filter:'Like tag:news',fields:'Like title,url,published_at'}}],
    ['GET','/posts/slug/{slug}/','get_post','Read a post'],
    ['GET','/pages/','list_pages','List pages'],
    ['GET','/tags/','list_tags','List tags']]},

  // ----- More facts, no key -----
  coingecko:{name:'CoinGecko',group:'Facts and news',base:'https://api.coingecko.com/api/v3',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/ping','ping','Is it up'],
    ['GET','/simple/price','price','Prices of coins',{q:{ids:'Like bitcoin,ethereum',vs_currencies:'Like eur,usd',include_24hr_change:'boolean:With the change in 24 hours'}}],
    ['GET','/search','search','Find a coin',{q:{query:'Words'}}],
    ['GET','/coins/markets','markets','Top coins by market',{q:{vs_currency:'Like eur',per_page:'integer:How many at most'}}]]},
  frankfurter:{name:'Exchange rates (ECB)',group:'Facts and news',base:'https://api.frankfurter.dev/v1',auth:{kind:'none'},key:'No key needed. Rates from the European Central Bank.',ops:[
    ['GET','/latest','latest','Today\'s rates',{q:{base:'Like EUR',symbols:'Like RON,USD'}}],
    ['GET','/{date}','on_date','Rates on a day (YYYY-MM-DD)',{q:{base:'Like EUR',symbols:'Like RON,USD'}}],
    ['GET','/currencies','currencies','The currencies']]},
  restcountries:{name:'Countries',group:'Facts and news',base:'https://restcountries.com/v3.1',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/name/{name}','by_name','A country by name'],
    ['GET','/alpha/{code}','by_code','A country by code, like RO']]},
  openlibrary:{name:'Open Library',group:'Facts and news',base:'https://openlibrary.org',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/search.json','search','Find books',{q:{q:'Words',author:'Author',limit:'integer:How many at most'}}],
    ['GET','/isbn/{isbn}.json','by_isbn','A book by ISBN']]},
  nagerdate:{name:'Public holidays',group:'Facts and news',base:'https://date.nager.at/api/v3',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/AvailableCountries','countries','The countries'],
    ['GET','/PublicHolidays/{year}/{countryCode}','holidays','Holidays in a year, like 2026 and RO'],
    ['GET','/NextPublicHolidays/{countryCode}','next_holidays','The next holidays in a country']]},
  arxiv:{name:'arXiv papers',group:'Facts and news',base:'https://export.arxiv.org/api',auth:{kind:'none'},key:'No key needed. Answers come as Atom XML.',ops:[
    ['GET','/query','search','Find papers',{q:{search_query:'Like all:transformer AND cat:cs.CL',max_results:'integer:How many at most',sortBy:'relevance, lastUpdatedDate or submittedDate'}}]]},
  npm:{name:'npm packages',group:'Facts and news',base:'https://registry.npmjs.org',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/-/v1/search','search','Find packages',{q:{text:'Words',size:'integer:How many at most'}}],
    ['GET','/{package}/latest','latest','The latest version of a package']]},
  pypi:{name:'PyPI packages',group:'Facts and news',base:'https://pypi.org/pypi',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/{project}/json','project','A Python package and its versions']]},
  usgs:{name:'Earthquakes (USGS)',group:'Facts and news',base:'https://earthquake.usgs.gov/fdsnws/event/1',auth:{kind:'none'},key:'No key needed.',ops:[
    ['GET','/query','earthquakes','Recent earthquakes',{q:{format:'geojson',starttime:'Date, like 2026-11-01',minmagnitude:'number:Smallest magnitude',limit:'integer:How many at most',orderby:'time or magnitude'}}]]}
};

// The order of the groups in the Add connector list.
export const PACK_GROUP_ORDER=['Work and projects','Sales and support','Payments and shops','Email and messages','Files, sites and content','Code and servers','AI and data','Facts and news'];

// The OpenAPI description SILO builds from a pack.
export function packSpec(id){
  const p=APP_PACKS[id];if(!p)throw new Error('There is no built-in app called '+id+'.');
  const paths={};
  for(const [method,route,name,summary,o={}] of p.ops){
    const parameters=[...route.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
    for(const [q,d] of Object.entries(o.q||{})){
      const m=String(d).match(/^(integer|number|boolean|array):(.*)$/);
      parameters.push({name:q,in:'query',description:m?m[2]:d,schema:m?(m[1]==='array'?{type:'array',items:{type:'string'}}:{type:m[1]}):{type:'string'}});
    }
    const op={operationId:name,summary,parameters,...((o.read||o.gql==='read')&&{'x-silo-read-only':true}),...(o.gql==='read'&&{'x-silo-graphql':'read'})};
    if(o.body)op.requestBody={required:true,content:{[o.form?'application/x-www-form-urlencoded':'application/json']:{schema:{type:o.body.startsWith('[')?'array':'object',description:(o.form?'Form fields like ':'JSON like ')+o.body}}}};
    // Two operations on the same address (a GraphQL read and change) get their own key; the request goes to route.
    let key=route;if(paths[key]?.[method.toLowerCase()]){key=route+'#'+name;op['x-silo-path']=route;}
    (paths[key]||={})[method.toLowerCase()]=op;
  }
  const first=p.ops.find(([m,r,,,o={}])=>m==='GET'&&!r.includes('{'));
  return {openapi:'3.0.3',info:{title:p.name,version:'1'},servers:[{url:p.base}],paths,...(p.headers&&{'x-silo-headers':p.headers}),'x-silo-check':p.check===false?false:p.check||(first?[first[2],{}]:false)};
}
