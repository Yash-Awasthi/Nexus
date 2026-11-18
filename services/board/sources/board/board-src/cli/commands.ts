// `@vercel/board/cli/commands`: board's CLI as data. Its parser and its help read this, and so can
// another CLI that runs it (`vercel board` renders board's help with its own renderer). It runs no
// command and imports nothing, so a host can load it on every start.

/** An option, as the parser takes it (`type`, `short`, `multiple`) and as help shows it. */
export type CliOption = {
  readonly name: string
  readonly type: 'string' | 'boolean'
  readonly short?: string
  /** It can be given more than once; each adds a value. */
  readonly multiple?: true
  /** What it takes, as help shows it: `N`, `k=v`. A boolean takes nothing. */
  readonly value?: string
  /** It may be given alone, without its value, as a bare `--mentions` means mentions of you. */
  readonly optionalValue?: true
  readonly description: string
  /** Kept for what still passes it, out of help. */
  readonly hidden?: true
}

export type CliArgument = {
  readonly name: string
  readonly required: boolean
  /** It takes one or more (or, optional, zero or more). */
  readonly multiple?: true
  readonly description?: string
}

/** A command line that does a job, as it follows the CLI's name (`read dev`). */
export type CliExample = { readonly name: string; readonly value: string }

export type CliCommand = {
  readonly name: string
  /** Other names it runs by: `rm` for `delete`. */
  readonly aliases?: readonly string[]
  readonly description: string
  /** The options most runs of it take, written after its usage in the list of commands: what a reader of that list alone would otherwise not know it has. */
  readonly brief?: string
  readonly arguments: readonly CliArgument[]
  /** Its own options: the filters (with `filters`) and the global options apply too. */
  readonly options: readonly CliOption[]
  /** It takes the filters (`--re`, `--by`, `--label`, …) as well. */
  readonly filters?: true
  /** What its filters do differently on some boards, as help says it under them. */
  readonly filtersNote?: string
  readonly examples: readonly CliExample[]
  readonly subcommands?: readonly CliCommand[]
  /** Its arguments come before its subcommand, as in `sources <key> read <target>`. */
  readonly argumentsBeforeSubcommand?: true
  /** It does something without a subcommand too, as `sources` lists the sync entries. */
  readonly runsWithoutSubcommand?: true
  /** The subcommand its command runs when given none, as `channels` runs `channels list`. */
  readonly default?: true
  /** Out of help: it still runs, for what calls it. */
  readonly hidden?: true
}

type Spec = Omit<CliOption, 'name'>

/** Every option, by name: what the parser accepts, and what each means where a command doesn't say more. */
export const options = {
  // Filters: what `read`, `tail`, and `wait` match, and a watcher's `tail`.
  re: { type: 'string', value: 'id', description: "in a thread: its root's ID" },
  by: { type: 'string', value: 'handle', description: 'by an author: a handle, me, or an actor ID' },
  mentions: { type: 'string', value: '@handle', optionalValue: true, description: 'mentioning a handle or email, or you without one' },
  label: { type: 'string', multiple: true, value: 'k[=v|w]', description: "with a label on the message or its thread's root" },
  source: { type: 'string', value: 'source', description: 'from a source: a sync key such as slack, or board' },
  text: { type: 'string', value: 'words', description: 'containing this text, as one phrase (a substring, not word search)' },
  after: { type: 'string', value: 'id', description: 'only what came after a message or a cursor (read and wait print one)' },
  // Global: every command takes them.
  url: { type: 'string', value: 'url', description: "the board at this URL, not the one the environment points at" },
  scope: { type: 'string', value: 'team', description: "a team's board in Vercel's API, by its slug or ID" },
  name: { type: 'string', value: 'board', description: "the team's board with this name, on --scope's team" },
  ensure: { type: 'boolean', description: 'with --name: make that board if the team has none by that name' },
  team: { type: 'string', value: 'team', description: 'the same as --scope', hidden: true },
  as: { type: 'string', value: 'profile', description: "write as a profile, such as an agent's name" },
  avatar: { type: 'string', value: 'url', description: "the profile's avatar, with --as" },
  json: { type: 'boolean', description: 'JSON, for programs' },
  help: { type: 'boolean', short: 'h', description: "this help, or a command's" },
  version: { type: 'boolean', short: 'v', description: "the CLI's version" },
  // Commands' own.
  limit: { type: 'string', short: 'n', value: 'N', description: 'how many' },
  last: { type: 'string', value: 'N', description: "start with the feed's newest N events (1 to 100)" },
  before: { type: 'string', value: 'older', description: "a channel's threads before a page: the older its read printed" },
  'idempotency-key': { type: 'string', value: 'key', description: 'sending the same one again posts once' },
  sync: { type: 'string', multiple: true, value: 'target', description: 'sync the new thread to a target too, e.g. slack:#incidents' },
  'no-sync': { type: 'boolean', description: 'keep it on the board: sync it nowhere' },
  attach: { type: 'string', multiple: true, value: 'file', description: 'attach a file: up to 10 per message, each up to 100 MB (4 MB on some boards)' },
  // What a command takes from a file: a message's text, a plan of tasks, several grants, a schema. Each says which.
  file: { type: 'string', value: 'path', description: 'from a file: - reads stdin' },
  data: { type: 'string', value: 'json', description: 'as JSON, written inline' },
  unset: { type: 'string', multiple: true, value: 'k', description: 'remove a label' },
  if: { type: 'string', multiple: true, value: 'k=v', description: 'only while the message has this label now' },
  'if-unset': { type: 'string', multiple: true, value: 'k', description: "only while the message doesn't have this label" },
  'if-revision': { type: 'string', value: 'N', description: 'only if it is still at this revision, as read --json shows it' },
  channel: { type: 'string', value: 'c', description: 'in a channel' },
  remove: { type: 'boolean', description: 'take the reaction back' },
  all: { type: 'boolean', short: 'a', description: 'everything, not only what most want' },
  timeout: { type: 'string', value: 'duration', description: 'how long to wait: 30s, 10m, or a bare number of seconds (default: 30m)' },
  'no-open': { type: 'boolean', description: "don't open the browser" },
  'allow-host': { type: 'string', multiple: true, value: 'host', description: 'also answer requests for this host, from a proxy in front: whoever reaches it there acts as you' },
  tailscale: { type: 'string', multiple: true, value: 'host', description: "also answer requests for this host, the board's name on your tailnet behind tailscale serve: whoever Tailscale says is calling is a person on the board" },
  in: { type: 'string', value: 'duration', description: 'once, this long from now, e.g. 90s, 5m, 1d' },
  at: { type: 'string', value: 'time', description: 'at a time: once, or with --every, the first' },
  every: { type: 'string', value: 'duration', description: 'repeating at this interval, e.g. 30m' },
  until: { type: 'string', short: 'u', value: 'time', description: 'repeating until a time' },
  for: { type: 'string', value: 'duration', description: 'repeating for this long, e.g. 24h' },
  times: { type: 'string', value: 'N', description: 'repeating this many times' },
  can: { type: 'string', multiple: true, value: 'pattern=perms', description: 'what they may do, repeated: perms, all, or none' },
  'lock-me-out': { type: 'boolean', description: "go ahead with a change you couldn't take back" },
  // Grants: whom one names, each flag a principal, with the modifiers after it.
  user: { type: 'string', multiple: true, value: 'email', description: 'a person on the team' },
  project: { type: 'string', multiple: true, short: 'p', value: 'name|id', description: "a project's deployments" },
  github: { type: 'string', multiple: true, value: 'owner/repo', description: "GitHub Actions' runs in a repository" },
  oidc: { type: 'string', multiple: true, value: 'issuer', description: "an issuer's tokens, by its URL" },
  'all-users': { type: 'boolean', description: 'every person on the team' },
  'all-projects': { type: 'boolean', description: "every project's deployments on the team" },
  app: { type: 'string', multiple: true, value: 'app', description: 'an app installed on the team' },
  'all-apps': { type: 'boolean', description: 'every app installed on the team' },
  everyone: { type: 'boolean', description: 'everyone let in some other way, and no one new' },
  environment: { type: 'string', multiple: true, short: 'e', value: 'environment', description: 'where its --project runs' },
  workflow: { type: 'string', multiple: true, value: 'file', description: "its --github's workflow, e.g. ci.yml" },
  'git-branch': { type: 'string', multiple: true, value: 'branch', description: "its --github's branch" },
  event: { type: 'string', multiple: true, value: 'event', description: "its --github's event, e.g. push" },
  claim: { type: 'string', multiple: true, value: 'k=v', description: "a claim its --oidc's tokens carry: sub always, ending in :* or /* to match how it starts" },
  'add-user': { type: 'string', multiple: true, value: 'email', description: 'add a person' },
  'add-project': { type: 'string', multiple: true, value: 'name|id', description: "add a project's deployments" },
  'add-github': { type: 'string', multiple: true, value: 'owner/repo', description: "add a repository's runs" },
  'add-oidc': { type: 'string', multiple: true, value: 'issuer', description: "add an issuer's tokens" },
  'add-all-users': { type: 'boolean', description: 'add every person on the team' },
  'add-all-projects': { type: 'boolean', description: 'add every project on the team' },
  'add-app': { type: 'string', multiple: true, value: 'app', description: 'add an app' },
  'add-all-apps': { type: 'boolean', description: 'add every app on the team' },
  'add-everyone': { type: 'boolean', description: 'add everyone something else lets in' },
  'remove-user': { type: 'string', multiple: true, value: 'email', description: 'remove a person' },
  'remove-project': { type: 'string', multiple: true, value: 'name|id', description: 'remove a project, whatever its environments' },
  'remove-github': { type: 'string', multiple: true, value: 'owner/repo', description: "remove a repository's runs" },
  'remove-oidc': { type: 'string', multiple: true, value: 'issuer', description: "remove an issuer's tokens" },
  'remove-all-users': { type: 'boolean', description: 'remove every person on the team' },
  'remove-all-projects': { type: 'boolean', description: 'remove every project on the team' },
  'remove-app': { type: 'string', multiple: true, value: 'app', description: 'remove an app' },
  'remove-all-apps': { type: 'boolean', description: 'remove every app on the team' },
  'remove-everyone': { type: 'boolean', description: 'remove everyone' },
  private: { type: 'boolean', description: 'closed to everyone but you, in the same write' },
  schema: { type: 'string', value: 'schema', description: 'the text is JSON for this schema, such as sandbox@1' },
  description: { type: 'string', value: 'text', description: 'what it holds, in a sentence' },
  port: { type: 'string', value: 'N', description: 'the port to listen on' },
  dir: { type: 'string', value: 'dir', description: 'where the board keeps its log (default: .board/)' },
  'no-inspect': { type: 'boolean', description: "don't start the inspector" },
  // Tasks.
  state: { type: 'string', value: 'state', description: 'in a state: waiting, ready, claimed, blocked, completed, failed, canceled, open, or all (default: open)' },
  needs: { type: 'string', multiple: true, value: 'id', description: 'wait for a task to complete first' },
  ready: { type: 'boolean', description: 'the oldest ready task in a channel, or under a prefix (work/)' },
  from: { type: 'string', multiple: true, value: 'id', description: "with --ready: take this owner's tasks too, by their ID" },
  wait: { type: 'string', value: 'duration', description: 'with --ready: how long to wait for one, e.g. 10m' },
  lease: { type: 'string', value: 'duration', description: 'how long to hold it: 30s to 1h (default: 15m, or what the board gives)' },
  result: { type: 'string', value: 'text', description: 'what it came to, when the command exits 0' },
  kind: { type: 'string', value: 'kind', description: 'what the hold is for: needs_input, awaiting_approval' },
  pool: { type: 'boolean', description: 'back to anyone who may claim it' },
  none: { type: 'boolean', description: 'wait for nothing' },
  // What a turn-end hook an earlier board installed still passes to `hook`.
  agent: { type: 'string', value: 'name', description: "the agent whose turn ended", hidden: true },
} as const satisfies Record<string, Spec>

export type OptionName = keyof typeof options

/** The option `name`, saying `description` (and taking `value`) where it means something particular to a command. */
export const option = (name: OptionName, description?: string, value?: string): CliOption => ({
  name,
  ...options[name],
  ...(description ? { description } : {}),
  ...(value ? { value } : {}),
})

/** What `read`, `tail`, and `wait` match: every one given must hold. */
export const filters: readonly CliOption[] = (['re', 'by', 'source', 'label', 'text', 'mentions', 'after'] as const).map((name) => option(name))

/** What every command takes. */
export const globalOptions: readonly CliOption[] = (['url', 'scope', 'name', 'ensure', 'team', 'as', 'avatar', 'json', 'help', 'version'] as const).map((name) =>
  option(name),
)

const id = (description = 'a message ID, as read shows it (#812)'): CliArgument => ({ name: 'id', required: true, description })
const text = (description = 'what it says: - reads it from stdin, and it may be left out when you --attach or --file'): CliArgument => ({
  name: 'text',
  required: false,
  description,
})

/** A task's ID: its thread's root's. */
const task = (description = "a task's ID, as tasks shows it (#812)"): CliArgument => ({ name: 'id', required: true, description })

/** `--claim` on a task: a flag there, where a grant's `--claim` takes a value. Its command's own definition is what the parser reads. */
const claimNow: CliOption = { name: 'claim', type: 'boolean', description: 'claim it in the same write' }

/** What `--after` means on a reply: a precondition, where on a read it's a position. */
const AFTER = "a reply only while this is the thread's newest message"

/** What one of the CLI's help pages lists together, in this order. */
export const groups = ['you', 'the board', 'messages', 'agents', 'live'] as const

/** Board's commands, by `groups`, in the order its help lists them. */
export const commands: readonly (CliCommand & { readonly group: (typeof groups)[number] })[] = [
  {
    group: 'you',
    name: 'whoami',
    description: 'who am I, on which board, with which credential, and what I can do',
    arguments: [],
    options: [],
    examples: [{ name: 'see who you are on the board', value: 'whoami' }],
  },
  {
    group: 'the board',
    name: 'grants',
    description: 'who may do what where, grant by grant',
    arguments: [],
    options: [],
    runsWithoutSubcommand: true,
    examples: [{ name: 'list the grants', value: 'grants' }],
    subcommands: [
      {
        name: 'list',
        default: true,
        description: "the board's grants",
        arguments: [],
        options: [],
        examples: [{ name: 'list the grants', value: 'grants list' }],
      },
      {
        name: 'create',
        description: 'let principals do what --can says, where it says',
        arguments: [],
        options: [
          ...(['user', 'project', 'github', 'oidc', 'app', 'all-users', 'all-projects', 'all-apps', 'everyone'] as const).map((name) => option(name)),
          option('environment', 'where its --project runs (default: production)'),
          ...(['workflow', 'git-branch', 'event', 'claim'] as const).map((name) => option(name)),
          option('can', 'what they may do, repeated: perms, all, or none', 'pattern=perms'),
          option('file', 'several grants, made in one write, from a JSON file: - reads stdin'),
          option('lock-me-out'),
        ],
        examples: [
          { name: 'let two people into security/', value: "grants create --user alice@acme.com --user bob@acme.com --can 'security/=all'" },
          { name: 'then close it to everyone else', value: "grants create --everyone --can 'security/=none'" },
          { name: 'several grants in one write, from a file', value: 'grants create --file grants.json' },
          { name: "a project's production and previews", value: "grants create --project sec --environment production,preview --can 'security/=read,post'" },
          { name: "two repositories' workflows", value: "grants create --github acme/web --workflow ci.yml --git-branch main --github acme/api --workflow deploy.yml --can 'ci/=post'" },
          { name: "another issuer's tokens, by their sub", value: "grants create --oidc https://gitlab.com --claim 'sub=project_path:acme/api:*' --claim project_id=42 --can 'ci/=post'" },
        ],
      },
      {
        name: 'update',
        description: 'add or remove principals, or replace its --can',
        arguments: [{ name: 'grant', required: true, description: 'its ID, as grants shows it (g3)' }],
        options: [
          ...(['add-user', 'add-project', 'add-github', 'add-oidc', 'add-app', 'add-all-users', 'add-all-projects', 'add-all-apps', 'add-everyone', 'remove-user', 'remove-project', 'remove-github', 'remove-oidc', 'remove-app', 'remove-all-users', 'remove-all-projects', 'remove-all-apps', 'remove-everyone', 'environment', 'workflow', 'git-branch', 'event', 'claim'] as const).map((name) => option(name)),
          option('can', 'replaces what it lets them do', 'pattern=perms'),
          option('lock-me-out'),
        ],
        examples: [
          { name: 'let another person in', value: 'grants update g4 --add-user carol@acme.com' },
          { name: 'drop a project, and narrow it', value: "grants update g5 --remove-project sec --can 'security/=read'" },
        ],
      },
      {
        name: 'explain',
        description: 'which grant decides a channel, for you or anyone',
        arguments: [{ name: 'channel', required: true, description: 'a channel, such as security/incidents' }],
        options: [...(['user', 'project', 'github', 'oidc', 'app', 'environment', 'workflow', 'git-branch', 'event', 'claim'] as const).map((name) => option(name))],
        examples: [
          { name: 'what you may do in a channel', value: 'grants explain security/incidents' },
          { name: 'what someone else may', value: 'grants explain --user bob@acme.com security/incidents' },
        ],
      },
      {
        name: 'revoke',
        description: 'stop letting them in',
        arguments: [{ name: 'grant', required: true, description: 'its ID, as grants shows it (g3)' }],
        options: [option('lock-me-out')],
        examples: [{ name: 'revoke a grant', value: 'grants revoke g3' }],
      },
    ],
  },
  {
    group: 'the board',
    name: 'channels',
    description: 'channels, a page at a time, grouped by path prefix: a first post makes one, and so does create',
    arguments: [{ name: 'prefix', required: false, description: 'only the channels whose path starts with it: dev/' }],
    options: [option('limit'), option('after')],
    runsWithoutSubcommand: true,
    examples: [
      { name: 'list the channels', value: 'channels' },
      { name: 'the ones under dev', value: 'channels dev/' },
    ],
    subcommands: [
      {
        name: 'list',
        default: true,
        description: 'channels, a page at a time, grouped by path prefix',
        arguments: [{ name: 'prefix', required: false, description: 'only the channels whose path starts with it: dev/' }],
        options: [option('limit'), option('after')],
        examples: [
          { name: 'list the channels', value: 'channels list' },
          { name: 'the next page, from the cursor a page ends with', value: 'channels list dev/ --after c.8f2a.2' },
        ],
      },
      {
        name: 'create',
        description: 'a channel, before anything posts to it (one that exists stays as it is)',
        arguments: [{ name: 'channel', required: true, description: 'its path, such as dev/alerts' }],
        options: [option('private')],
        examples: [
          { name: 'make a channel for alerts', value: 'channels create dev/alerts' },
          { name: 'one only you can see, until you grant others', value: 'channels create security --private' },
        ],
      },
    ],
  },
  {
    group: 'the board',
    name: 'schemas',
    description: 'schemas for structured data: versions that never change',
    arguments: [],
    options: [],
    runsWithoutSubcommand: true,
    examples: [{ name: 'list the schemas', value: 'schemas' }],
    subcommands: [
      {
        name: 'list',
        default: true,
        description: "the built-in schemas, then the board's own",
        arguments: [],
        options: [],
        examples: [{ name: 'list the schemas', value: 'schemas list' }],
      },
      {
        name: 'inspect',
        description: 'one version, with its JSON Schema',
        arguments: [{ name: 'schema', required: true, description: 'its ID, as schemas shows it (sandbox@1)' }],
        options: [],
        examples: [{ name: 'see what a sandbox event holds', value: 'schemas inspect sandbox@1' }],
      },
      {
        name: 'create',
        description: 'register a version, for good: the same definition again changes nothing',
        arguments: [{ name: 'schema', required: true, description: 'its name and version, such as sandbox@1' }],
        options: [option('file', 'its JSON Schema, from a file: - reads stdin'), option('data', 'its JSON Schema, written inline'), option('description')],
        examples: [
          { name: 'register a version from a file', value: "schemas create sandbox@1 --file sandbox.schema.json --description 'What a sandbox did.'" },
          { name: 'or inline', value: `schemas create ping@1 --data '{"type":"object","required":["at"],"properties":{"at":{"type":"string","format":"date-time"}}}'` },
        ],
      },
    ],
  },
  {
    group: 'the board',
    name: 'actors',
    description: 'actors and their handles',
    arguments: [],
    options: [],
    examples: [{ name: 'list who has written here', value: 'actors' }],
  },
  {
    group: 'messages',
    name: 'read',
    description: 'the latest threads, one each (root, replies, latest reply), or one thread, every message',
    arguments: [
      {
        name: 'channel|id|link',
        required: false,
        description: "a channel (every channel without one, but not on Vercel's board), a message's ID, or a Slack or GitHub link the board synced",
      },
    ],
    options: [option('limit', 'threads to list (default: 50, at most 500)'), option('before')],
    filters: true,
    filtersNote: "Vercel's board reads one channel or thread here, with only --re, --label, and --after, or on a channel --mentions and --text, which look through one page of its threads: it keeps no search index",
    examples: [
      { name: "list a channel's latest threads", value: 'read dev' },
      { name: 'read one thread, every message', value: 'read 812' },
      { name: 'list the open bugs', value: 'read dev --label kind=bug --label state=open' },
      { name: 'what mentions you, before you wait for more: it prints the wait that goes on from there', value: 'read dev --mentions' },
      { name: "only what's new since the cursor an earlier read printed", value: 'read dev --after 1042' },
      { name: 'the page before one, by the older it printed', value: 'read dev --before 1031.1024' },
    ],
  },
  {
    group: 'messages',
    name: 'post',
    brief: '[--label k=v]... [--attach file]...',
    description: 'a new thread in a channel, or with an ID, a reply in its thread',
    arguments: [{ name: 'channel|id', required: true, description: 'a channel, or a message ID to reply in its thread' }, text()],
    options: [option('label', 'label it', 'k=v'), option('file', 'the text, from a file: - reads stdin'), option('schema'), option('attach'), option('sync', "sync the new thread to a target too, e.g. slack:#incidents (not on Vercel's board yet)"), option('no-sync'), option('idempotency-key'), option('after', AFTER)],
    examples: [
      { name: 'start a thread', value: 'post dev "deploys are green again"' },
      { name: 'start a labeled thread', value: 'post dev "checkout times out" --label kind=bug' },
      { name: 'post data that matches a schema', value: `post deploys --schema sandbox@1 '{"id":"sbx-123","action":"started"}'` },
    ],
  },
  {
    group: 'messages',
    name: 'reply',
    description: 'a reply in a thread',
    arguments: [id('the ID of a message in the thread'), text()],
    options: [option('label', 'label it', 'k=v'), option('file', 'the text, from a file: - reads stdin'), option('schema'), option('attach'), option('idempotency-key'), option('no-sync'), option('after', AFTER)],
    examples: [
      { name: 'reply in a thread', value: 'reply 812 "on it"' },
      { name: 'reply with a label', value: 'reply 812 "fixed in a1b2c3" --label step=fix' },
      { name: "reply only if #815 is still the thread's newest", value: 'reply 812 "on it" --after 815' },
    ],
  },
  {
    group: 'messages',
    name: 'schedule',
    brief: '(--in 5m | --at time | --every 30m)',
    description: 'post later, as you: once (--in or --at), or repeating (--every) until a stop or until canceled',
    arguments: [{ name: 'channel|id', required: true, description: 'a channel, or a message ID to reply in its thread' }, text()],
    options: [option('in'), option('at'), option('every'), option('until'), option('for'), option('times'), option('label', 'label it', 'k=v'), option('file', 'the text, from a file: - reads stdin'), option('schema'), option('attach', "attach a file to what it posts (not on Vercel's board yet)"), option('no-sync')],
    examples: [
      { name: 'reply in a thread tomorrow', value: 'schedule 812 "still broken?" --in 1d' },
      { name: 'post every morning', value: 'schedule dev "standup" --at 2026-11-02T09:00:00Z --every 1d' },
    ],
    runsWithoutSubcommand: true,
    subcommands: [
      {
        name: 'cancel',
        description: 'stop one (yours, or with manage)',
        arguments: [{ name: 'schedule', required: true, description: 'its ID, as schedules shows it (s12)' }],
        options: [],
        examples: [{ name: 'cancel a schedule', value: 'schedule cancel s12' }],
      },
    ],
  },
  {
    group: 'messages',
    name: 'schedules',
    brief: '[--by handle] [--all]',
    description: "pending schedules, a thread's with a message ID, or one by its own ID",
    arguments: [{ name: 'id', required: false, description: 'a message in the thread, or a schedule (s12): sent, canceled, or pending' }],
    options: [option('by', 'scheduled by a handle'), option('channel', 'posting in a channel'), option('all', 'done and canceled ones too')],
    examples: [{ name: 'list pending schedules', value: 'schedules' }],
  },
  {
    group: 'messages',
    name: 'edit',
    description: "change a message's text",
    arguments: [id(), { name: 'text', required: false, description: 'its new text: - reads it from stdin, and it may be left out when you --file' }],
    options: [option('file', 'the text, from a file: - reads stdin'), option('schema'), option('if-revision')],
    examples: [
      { name: 'fix a typo', value: 'edit 812 "deploys are green again"' },
      { name: 'only if no one changed it since you read it', value: 'edit 812 "step 3 of 5" --if-revision 820' },
    ],
  },
  {
    group: 'messages',
    name: 'delete',
    aliases: ['rm', 'del'],
    description: 'delete a message, leaving a tombstone',
    arguments: [id()],
    options: [option('if-revision')],
    examples: [{ name: 'delete a message', value: 'delete 812' }],
  },
  {
    group: 'messages',
    name: 'react',
    description: 'react to a message',
    arguments: [id(), { name: 'emoji', required: true, description: 'its name or the emoji itself: eyes, 👀' }],
    options: [option('remove')],
    examples: [{ name: 'react with eyes', value: 'react 812 eyes' }],
  },
  {
    group: 'messages',
    name: 'label',
    brief: '[--if-unset k] [--unset k]',
    description: 'set labels on a message, or remove them',
    arguments: [id(), { name: 'k=v', required: false, multiple: true, description: 'a label to set: a key of up to 64 lowercase letters, numbers, ., _, and -, starting with a letter or number, and a value of up to 256 characters' }],
    options: [option('unset'), option('if'), option('if-unset')],
    examples: [
      { name: 'mark a bug fixed', value: 'label 812 state=fixed --unset wip' },
      { name: 'claim a thread, unless someone has', value: 'label 812 owner=claude --if-unset owner' },
      { name: 'move it on from open only', value: 'label 812 state=fixing --if state=open' },
    ],
  },
  {
    group: 'messages',
    name: 'typing',
    description: "show typing in the thread's synced platform threads",
    arguments: [id(), { name: 'status', required: false, description: 'what Slack shows instead of "Typing…"' }],
    options: [],
    examples: [{ name: 'show typing while you work', value: 'typing 812 "looking into it"' }],
  },
  {
    group: 'messages',
    name: 'sync',
    description: "where the thread is synced, or with a target, attach it there (backfilling it)",
    arguments: [id(), { name: 'target', required: false, description: 'where to sync it, e.g. slack:#incidents' }],
    options: [],
    examples: [
      { name: 'list where a thread is synced', value: 'sync 812' },
      { name: 'sync a thread to a Slack channel', value: 'sync 812 slack:#incidents' },
    ],
  },
  {
    group: 'messages',
    name: 'inbox',
    description: 'raw platform events, for debugging sync',
    arguments: [
      { name: 'key', required: true, description: 'the sync entry, e.g. slack' },
      { name: 'channel', required: false, description: 'the board channel its events went to' },
    ],
    options: [option('limit', 'events to list')],
    examples: [{ name: "list Slack's latest events", value: 'inbox slack' }],
  },
  {
    group: 'messages',
    name: 'sources',
    description: "the board's sources: its sync entries (slack, github, …)",
    arguments: [{ name: 'key', required: false, description: 'a sync entry, e.g. slack' }],
    options: [],
    runsWithoutSubcommand: true,
    argumentsBeforeSubcommand: true,
    examples: [{ name: "list the board's sources", value: 'sources' }],
    subcommands: [
      {
        name: 'read',
        description: "read a source's channel, thread, or message link without syncing it (full access only)",
        arguments: [{ name: 'target', required: true, description: "a channel ('#general'), a thread, or a message link" }],
        options: [option('limit', 'messages to read'), option('after', "where the last read left off: the cursor it printed")],
        examples: [{ name: 'read a Slack channel', value: "sources slack read '#general'" }, { name: "read a Linear project's issues", value: 'sources linear read https://linear.app/acme/project/checkout-a1b2c3' }],
      },
      {
        name: 'join',
        description: 'add the app to a public channel so it can be read, where the board opted in (full access only)',
        arguments: [{ name: 'channel', required: true, description: 'a channel or its link' }],
        options: [],
        examples: [{ name: 'join a Slack channel', value: "sources slack join '#general'" }],
      },
    ],
  },
  {
    group: 'messages',
    name: 'download',
    description: "save an attachment (its name, here, by default; - for stdout)",
    arguments: [
      { name: 'attachment-id', required: true, description: "the ID at the end of a file line when you read its thread, not the file's name" },
      { name: 'path', required: false, description: 'where to save it, or - for stdout' },
    ],
    options: [],
    examples: [{ name: 'save an attachment', value: 'download Yt2mR8vQ1x0pLk3sF7dA9w' }],
  },
  {
    group: 'messages',
    name: 'conformance',
    description: 'check that a board you name speaks the protocol (1 if a check fails): it posts, and deletes what it posted',
    arguments: [],
    options: [option('channel', 'the channel to check in (default: conformance)')],
    examples: [{ name: 'check the board', value: 'conformance' }],
  },
  {
    group: 'agents',
    name: 'tasks',
    description: 'open tasks, oldest first: threads agents are to do, each with a state the board keeps',
    arguments: [{ name: 'channel', required: false, description: 'a channel, or a path prefix (work/); every channel without one' }],
    options: [
      option('state'),
      option('label', 'with a label on its root', 'k[=v|w]'),
      option('by', 'whose root a handle wrote'),
      option('for', 'assigned to a profile of yours', 'profile'),
      option('after', 'after a cursor an earlier page printed', 'cursor'),
      option('limit', 'tasks to list (default: 50)'),
    ],
    runsWithoutSubcommand: true,
    examples: [
      { name: "list a queue's open tasks", value: 'tasks work/' },
      { name: 'list what is ready to fix', value: 'tasks work/ --state ready --label step=fix' },
    ],
    subcommands: [
      {
        name: 'create',
        description: 'start a thread as a task, or with an ID, make that thread one: you own it. With --file, a plan of them',
        arguments: [
          { name: 'channel|id', required: true, description: "a channel, or a thread's ID to make a task of it as it is" },
          { name: 'text', required: false, description: 'what to do, for a new thread: - reads it from stdin, and --file takes its place' },
        ],
        options: [
          option('label', 'label it, to route it', 'k=v'),
          option('needs'),
          option('for', 'only this profile of yours claims it', 'profile'),
          claimNow,
          option('lease', 'with --claim: how long to hold it'),
          option('file', 'a plan, from a JSON file (- reads stdin): an array of tasks, each { key?, text, labels?, needs?, for?, noSync?, attachments? }, all made, in as many writes as it takes'),
          option('no-sync'),
          option('idempotency-key', 'sending the same one again makes it once'),
        ],
        examples: [
          { name: 'hand a fix to whoever takes fixes', value: 'tasks create work "fix CVE-123 in acme/web" --label step=fix' },
          { name: 'a review that waits for it', value: 'tasks create work "review the fix for CVE-123" --label step=review --needs 812' },
          { name: 'make a task of a thread that is there', value: 'tasks create 812' },
          { name: 'a plan of tasks that wait for each other', value: 'tasks create work --file plan.json --idempotency-key migration-7' },
        ],
      },
      {
        name: 'claim',
        description: 'hold a task for a lease, by its ID, or with --ready the oldest ready one in a channel',
        arguments: [{ name: 'id|channel', required: true, description: "a task's ID, or with --ready a channel or a path prefix (work/)" }],
        options: [option('ready'), option('label', 'with --ready: one whose root has this label, one value exactly', 'k=v'), option('from'), option('wait'), option('lease')],
        examples: [
          { name: 'claim a task', value: 'tasks claim 812' },
          { name: 'claim the next fix, waiting for one', value: 'tasks claim --ready work/ --label step=fix --wait 10m' },
        ],
      },
      {
        name: 'run',
        description: 'claim a task and run a command on it: renew while it runs, complete on exit 0, fail otherwise',
        arguments: [
          { name: 'id|channel', required: true, description: "a task's ID, or with --ready a channel or a path prefix" },
          { name: 'cmd', required: true, multiple: true, description: 'the command, after --: it gets BOARD_TASK, the task\'s ID' },
        ],
        options: [option('result'), option('ready'), option('label', 'with --ready: one whose root has this label, one value exactly', 'k=v'), option('from'), option('wait'), option('lease')],
        examples: [
          { name: 'run the tests as a task', value: 'tasks run 812 --result "tests pass" -- make test' },
          { name: 'work the next fix', value: 'tasks run --ready work/ --label step=fix -- ./fix.sh' },
        ],
      },
      {
        name: 'renew',
        description: 'extend the lease of a task you hold, from now',
        arguments: [task()],
        options: [option('lease')],
        examples: [{ name: 'hold it for another 30 minutes', value: 'tasks renew 812 --lease 30m' }],
      },
      {
        name: 'release',
        description: 'give a task you hold back: it is ready again',
        arguments: [task()],
        options: [],
        examples: [{ name: 'give a task back', value: 'tasks release 812' }],
      },
      {
        name: 'complete',
        description: 'finish a task you hold: what waits only for it is ready',
        arguments: [task(), { name: 'result', required: false, description: 'what it came to, in a line' }],
        options: [],
        examples: [{ name: 'complete a task', value: 'tasks complete 812 "fixed in a1b2c3, tests pass"' }],
      },
      {
        name: 'fail',
        description: "give up on a task you hold: what waits for it keeps waiting, until it's reopened",
        arguments: [task(), { name: 'reason', required: true, description: 'why, in a line' }],
        options: [],
        examples: [{ name: 'fail a task', value: 'tasks fail 812 "the tests need a database"' }],
      },
      {
        name: 'block',
        description: 'hold a task for a person: with your claim, which it ends, or as its owner',
        arguments: [task(), { name: 'reason', required: true, description: 'what you need from them' }],
        options: [option('kind')],
        examples: [{ name: 'ask for approval', value: 'tasks block 813 "approve the prod deploy?" --kind awaiting_approval' }],
      },
      {
        name: 'unblock',
        description: 'lift a hold, as its owner: ready again, or waiting while a task it needs has not completed',
        arguments: [task()],
        options: [],
        examples: [{ name: 'lift a hold', value: 'tasks unblock 813' }],
      },
      {
        name: 'reopen',
        description: 'make a failed task ready again, as its owner',
        arguments: [task()],
        options: [],
        examples: [{ name: 'retry a failed task', value: 'tasks reopen 812' }],
      },
      {
        name: 'assign',
        description: "keep a task for one of its owner's profiles, or with --pool, for anyone who may claim it",
        arguments: [task(), { name: 'profile', required: false, description: "a profile of the task's owner, such as fixer" }],
        options: [option('pool')],
        examples: [
          { name: 'keep it for the fixer', value: 'tasks assign 812 fixer' },
          { name: 'back to the pool', value: 'tasks assign 812 --pool' },
        ],
      },
      {
        name: 'needs',
        description: 'set what a task waits for, as its owner: the tasks named, in place of what it waited for',
        arguments: [task(), { name: 'needs', required: false, multiple: true, description: 'the tasks it waits for now, by ID' }],
        options: [option('none')],
        examples: [
          { name: 'wait for two tasks', value: 'tasks needs 814 812 813' },
          { name: 'wait for nothing', value: 'tasks needs 814 --none' },
        ],
      },
      {
        name: 'cancel',
        description: 'cancel a task that has not completed, as its owner: any claim ends',
        arguments: [task(), { name: 'reason', required: true, description: 'why, in a line' }],
        options: [],
        examples: [{ name: 'cancel a task', value: 'tasks cancel 812 "superseded by #820"' }],
      },
    ],
  },
  {
    group: 'agents',
    name: 'hooks',
    description: 'the turn-end hooks an earlier board installed',
    arguments: [],
    options: [],
    examples: [],
    subcommands: [
      {
        name: 'uninstall',
        description: 'remove the turn-end hooks an earlier board installed, from every agent or the ones named',
        arguments: [{ name: 'agent', required: false, multiple: true, description: 'claude, codex, cursor, or pi' }],
        options: [],
        examples: [{ name: 'remove every hook', value: 'hooks uninstall' }],
      },
    ],
  },
  {
    group: 'agents',
    name: 'hook',
    description: 'what an earlier turn-end hook runs: it does nothing now',
    arguments: [{ name: 'event', required: false, multiple: true }],
    options: [option('agent')],
    examples: [],
    hidden: true,
  },
  {
    group: 'live',
    name: 'tail',
    description: 'what happens, live, until Ctrl-C',
    arguments: [{ name: 'channel', required: false, description: 'a channel, or a path prefix (dev/)' }],
    options: [option('all', 'delivery receipts too'), option('last')],
    filters: true,
    examples: [
      { name: 'follow the bugs', value: 'tail dev --label kind=bug' },
      { name: "start with a channel's newest 20 events, then follow", value: 'tail dev --last 20' },
    ],
  },
  {
    group: 'live',
    name: 'wait',
    brief: '[--after id] [--timeout 10m]',
    description: 'block for the next match and print it',
    arguments: [{ name: 'channel|id', required: false, description: "a channel, a path prefix (dev/), or a message's ID: what comes after it in its thread" }],
    options: [option('timeout')],
    filters: true,
    examples: [
      { name: 'wait for a mention: it sees only what comes after it starts, so read dev --mentions first. When none comes in time it says "Nothing matched" and exits 1', value: 'wait dev --mentions --timeout 10m' },
      { name: "wait for a reply in a thread, from the last message you read so none is missed", value: 'wait --re 812 --after 815 --timeout 10m' },
    ],
  },
  {
    group: 'live',
    name: 'help',
    description: "this help, or a command's",
    arguments: [{ name: 'command', required: false, multiple: true }],
    options: [],
    examples: [],
    hidden: true,
  },
]

/** One line of `usage`: a command's path and its arguments, as `<required>` and `[optional]`. */
export function usage(path: readonly CliCommand[]): string {
  const words: string[] = []
  path.forEach((command, at) => {
    const last = at === path.length - 1
    words.push(command.name)
    // A parent's arguments show before its subcommand only when it takes them there, and then the subcommand needs them.
    if (last || command.argumentsBeforeSubcommand)
      for (const argument of command.arguments) {
        const required = argument.required || !last
        words.push(`${required ? `<${argument.name}>` : `[${argument.name}]`}${argument.multiple ? '...' : ''}`)
      }
  })
  if (path.at(-1)?.filters) words.push('[filters]')
  return words.join(' ')
}
