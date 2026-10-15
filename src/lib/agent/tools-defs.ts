/**
 * Finance agent tool definitions. These describe to the LLM what functions
 * it can call when processing a chat message.
 *
 * Tool implementations live in src/lib/agent/tools.ts — they take the parsed
 * JSON args + userId, mutate the DB, and return a result string.
 *
 * NOTE: Tool names + schemas here must match the implementations in tools.ts.
 */
import type { ToolDefinition } from "@/lib/llm/client";

export const DAILY_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "log_expense",
      description:
        "Log an expense (money going out). Use when user describes spending money on something. Examples: 'rapido 20rs', 'khana 150', 'petrol 500', 'rent 12000'.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount in INR (e.g., 20, 150, 500)" },
          category: {
            type: "string",
            description:
              "Category name. Try to match existing categories from schema-in-context. If none fits, suggest a new one.",
          },
          account: {
            type: "string",
            description:
              "Source account name (e.g., 'SBI', 'Cash'). If user doesn't specify, omit — agent will ask via ask_clarification if needed.",
          },
          contact: {
            type: "string",
            description: "Contact name if expense is to a person (e.g., 'paid Rahul back 500')",
          },
          timestamp: {
            type: "string",
            description:
              "ISO 8601 timestamp of when it happened. If user says 'today' use the current date. If 'kal' or 'yesterday', use current date - 1 day. If no time mentioned, omit (defaults to now).",
          },
          notes: {
            type: "string",
            description: "Any extra context user mentioned (e.g., 'for IPO investment')",
          },
          group_label: {
            type: "string",
            description: "Optional label to link this txn to a multi-leg group (e.g., 'Rahul SBI IPO plan'). If the group doesn't exist, it's created. Use the SAME label across all legs of a complex scenario so they're linked.",
          },
        },
        required: ["amount", "category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_income",
      description:
        "Log income (money coming in). Use when user describes receiving money. Examples: 'salary 50k aaya', 'rahul ne 30 hazar diye', 'refund 500 mila'.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount in INR" },
          category: {
            type: "string",
            description: "Category name (e.g., 'Salary', 'Investment returns', 'Gift received', 'Loan repayment received')",
          },
          account: { type: "string", description: "Destination account name" },
          contact: { type: "string", description: "Person who gave the money (if applicable)" },
          timestamp: { type: "string", description: "ISO 8601 timestamp (omit for now)" },
          notes: { type: "string" },
          group_label: { type: "string", description: "Optional label for multi-leg linking (see log_expense)" },
        },
        required: ["amount", "category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_transfer",
      description:
        "Log a transfer between two of the user's own accounts (NOT to/from a contact). Use when user says things like '2k SBI se ICICI mein daal diya'. For money to/from a friend, use log_income or log_expense with contact.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          from_account: { type: "string", description: "Source account name" },
          to_account: { type: "string", description: "Destination account name" },
          timestamp: { type: "string" },
          notes: { type: "string" },
          group_label: { type: "string", description: "Optional label for multi-leg linking (see log_expense)" },
        },
        required: ["amount", "from_account", "to_account"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_transactions",
      description: "Link two or more existing transactions into a multi-leg group. Use this when you realize AFTER logging that some txns belong together (e.g., 'a friend2019s 30k loan + IPO investment + 10k profit' should be one group).",
      parameters: {
        type: "object",
        properties: {
          txn_ids: { type: "array", items: { type: "string" }, description: "Array of transaction IDs to link" },
          group_label: { type: "string", description: "Human-readable label for the group" },
          description: { type: "string", description: "Optional description of what this group represents" },
        },
        required: ["txn_ids", "group_label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_event",
      description: "Mark a non-financial event as a transaction with amount=0 (e.g., 'IPO got selected', 'SIP completed', 'order delivered'). Useful for tracking the lifecycle of a group without polluting financial totals.",
      parameters: {
        type: "object",
        properties: {
          event_type: { type: "string", description: "e.g., 'ipo_selected', 'sip_completed', 'order_delivered'" },
          related_account: { type: "string", description: "Account name if applicable" },
          related_contact: { type: "string", description: "Contact name if applicable" },
          timestamp: { type: "string" },
          notes: { type: "string" },
          group_label: { type: "string", description: "Optional label for multi-leg linking" },
        },
        required: ["event_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_account",
      description:
        "Create a NEW account in the user's schema. ONLY call when user mentions an account that doesn't exist in schema-in-context. Examples: 'I opened a new ICICI bank account', 'made a new demat in Zerodha'.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Account name (e.g., 'ICICI Savings', 'Zerodha Demat')" },
          type: {
            type: "string",
            enum: ["bank", "demat", "wallet", "cash", "investment", "other"],
          },
          institution: { type: "string", description: "e.g., 'ICICI', 'Zerodha', 'HDFC'" },
          opening_balance: { type: "number", description: "Starting balance if mentioned (default 0)" },
        },
        required: ["name", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_contact",
      description:
        "Create a NEW contact (person) in the user's schema. ONLY call when user mentions a person not in schema-in-context. Examples: 'mere dost Rahul ne...', 'bhai ne diya'.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Contact name (e.g., 'Rahul')" },
          type: {
            type: "string",
            enum: ["friend", "family", "colleague", "merchant", "other"],
          },
          relationship: { type: "string", description: "e.g., 'college friend', 'brother'" },
        },
        required: ["name", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description:
        "Ask the user a clarifying question when info is genuinely ambiguous and you can't confidently log the transaction. Use sparingly — try to infer from context first.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask. Be specific. Example: 'Which account did the 500 go from — SBI or Cash?'",
          },
          context: {
            type: "string",
            description: "JSON string of what was ambiguous (for audit). e.g., '{\"missing\":\"account\"}'",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "retrieve_transactions",
      description:
        "Semantic search over transaction history. Use when the user asks a natural-language question about past spending, income or money sent to someone (e.g., 'show me my rapido expenses', 'how much money did I send to Rahul 3 months ago', 'what did I spend on food last month'). Always pass from_date/to_date (computed from the current date in context) when the user mentions any relative time — '3 months ago', 'last week', 'June', etc. Returns ranked matches with amounts + timestamps.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query describing what the user is asking about (e.g., 'money sent to Rahul', 'rapido rides', 'food with friends')" },
          top_n: { type: "number", description: "Max matches to return (default 25)" },
          days: { type: "number", description: "Look-back window in days (default 90). Use 365 for last year, 1825 for last 5 years." },
          from_date: { type: "string", description: "ISO date (YYYY-MM-DD) lower bound (overrides days). COMPUTE this from current date for any relative-time question." },
          to_date: { type: "string", description: "ISO date (YYYY-MM-DD) upper bound" },
        },
        required: ["query"],
      },
    },
  },
  // ---- Analysis tools (shared with the dashboard agent — the daily chat can
  //      answer analytical questions and offer charts directly) ----
  {
    type: "function",
    function: {
      name: "query_transactions",
      description:
        "Query the user's transactions with structured filters (date range, type, account, contact, category). Returns matching transactions as JSON. Use for 'show all my expenses from 1st to 15th', 'everything from my SBI account in June', etc.",
      parameters: {
        type: "object",
        properties: {
          from_date: { type: "string", description: "ISO date (YYYY-MM-DD). Omit for no lower bound." },
          to_date: { type: "string", description: "ISO date (YYYY-MM-DD). Omit for no upper bound." },
          type: { type: "string", enum: ["expense", "income", "transfer", "investment", "loan_out", "loan_in", "profit", "loss", "fee"] },
          account: { type: "string", description: "Account name (substring match)" },
          contact: { type: "string", description: "Contact name (substring match)" },
          category: { type: "string", description: "Category name (substring match)" },
          limit: { type: "number", description: "Max results. Default 100." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate",
      description:
        "Aggregate transactions by a dimension (sum, count, avg). Returns JSON { dimension_value, total_amount, count, avg_amount }[]. Use for totals like 'month expense by category', 'how much did I send to Rahul between March and May'.",
      parameters: {
        type: "object",
        properties: {
          from_date: { type: "string" },
          to_date: { type: "string" },
          type: { type: "string" },
          group_by: { type: "string", enum: ["category", "account", "contact", "day", "week", "month", "type"] },
        },
        required: ["group_by"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account_summary",
      description: "Get a snapshot of all user accounts with CURRENT live balances. Use whenever the user asks 'how much do I have', 'what's my balance', 'net worth', or before answering questions that depend on current balances.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_groups",
      description: "List all multi-leg transaction groups for this user (with leg counts, net amount, creation date). Use when user asks 'show me the IPO plan' or 'what groups do I have'.",
      parameters: {
        type: "object",
        properties: {
          label_contains: { type: "string", description: "Optional substring filter on group label" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_group_summary",
      description: "Get full details of a single transaction group: all legs with their types, amounts, accounts, contacts, timestamps. Use when user asks 'tell me about the IPO plan'.",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "string", description: "Group ID (from list_groups)" },
          label: { type: "string", description: "OR group label (substring match)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_scheduled_notification",
      description:
        "Schedule a push-notification reminder with a calendar-style schedule. Use when the user says 'remind me at 8pm daily', 'send me my day's summary at 9:10pm', 'notify me next Monday at 6am', 'every month on the 1st at 10am'. NEVER output cron expressions — pass structured fields. Message may include placeholders: {today_income}, {today_expense}, {month_income}, {month_expense}.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["once", "daily", "weekly", "monthly"], description: "Repeat kind" },
          time: { type: "string", description: "'HH:MM' 24-hour IST, e.g. '20:00' for 8pm, '21:10' for 9:10pm" },
          date: { type: "string", description: "YYYY-MM-DD — required when type=once. Compute from current date in context ('tomorrow' = current date + 1)." },
          days: { type: "array", items: { type: "number" }, description: "Weekdays 0=Sunday…6=Saturday — required when type=weekly, e.g. [1] Monday, [1,3,5] Mon/Wed/Fri" },
          day_of_month: { type: "number", description: "1-31 — required when type=monthly" },
          title: { type: "string", description: "Short notification title (default 'Khata')" },
          message: { type: "string", description: "Message text. May include {today_income} {today_expense} {month_income} {month_expense}" },
        },
        required: ["type", "time", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_data",
      description: "Trigger a CSV/PDF export of transactions. Returns a download URL the user can click.",
      parameters: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["csv", "pdf"] },
          from_date: { type: "string" },
          to_date: { type: "string" },
        },
        required: ["format"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_chat_history",
      description:
        "Search the user's ENTIRE saved chat history (every message ever exchanged, far beyond recent context). Use when the user refers to an old conversation or something they told you before that isn't in recent context — e.g. 'what did I say about the ICICI account last month?', 'wo baat jo maine march mein boli thi'.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search for in past messages" },
          from_date: { type: "string", description: "ISO date (YYYY-MM-DD) lower bound" },
          to_date: { type: "string", description: "ISO date (YYYY-MM-DD) upper bound" },
          limit: { type: "number", description: "Max matches (default 15)" },
        },
        required: ["query"],
      },
    },
  },
];

// ============================================================
//  Dashboard-only tools (mindmap agentic edits — the review UI lives in
//  the dashboard; everything else is shared with DAILY_TOOLS above)
// ============================================================

export const DASHBOARD_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_mindmaps",
      description: "List all of the user's saved mindmaps (id + name + updatedAt). Use when user asks 'show me my mindmaps' or 'what mindmaps do I have'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mindmap",
      description: "Get full content of a mindmap (nodes + edges) by id or by name (substring match).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Mindmap ID (from list_mindmaps)" },
          name: { type: "string", description: "OR mindmap name (substring match)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_mindmap_edit",
      description:
        "Propose an edit to an existing mindmap. The proposed nodes + edges are returned for the USER TO REVIEW + SAVE — do NOT claim the mindmap is saved until the user clicks Save. Use when user asks 'add a node for X', 'rearrange my mindmap', 'group these by category', etc. The agent emits the proposed graph; the user reviews in the mindmap editor UI. SIMPLIFIED node shape: just {id, label}. Positions are auto-assigned. Full React Flow shape ({id, type, position, data}) also accepted if you want to control layout.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Mindmap ID (preferred)" },
          name: { type: "string", description: "OR mindmap name (substring match)" },
          nodes: {
            type: "array",
            description: "FULL new nodes array (REPLACES existing). SIMPLE shape (preferred): {id: string, label: string}. Server auto-assigns type='default' + position. Full shape also OK: {id, type:'input'|'output'|'default', position:{x,y}, data:{label}}",
            items: { type: "object" },
          },
          edges: {
            type: "array",
            description: "FULL new edges array (REPLACES existing). Simple shape: {source, target}. Full shape: {id, source, target, label?}. Server auto-generates missing IDs.",
            items: { type: "object" },
          },
          summary: { type: "string", description: "Human-readable description of what you changed (e.g., 'Added 3 nodes for investment categories + linked them to root')" },
        },
        required: ["summary"],
      },
    },
  },
  // Daily tools are also available to dashboard agent
  ...DAILY_TOOLS,
];
