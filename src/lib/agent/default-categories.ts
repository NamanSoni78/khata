/**
 * Default categories — seeded per user on first MPIN setup.
 * Kept in a separate module so importing it doesn't trigger the seed runner.
 */
export const DEFAULT_CATEGORIES = [
  { name: "Food", type: "expense", icon: "🍜" },
  { name: "Transport", type: "expense", icon: "🚕" },
  { name: "Groceries", type: "expense", icon: "🛒" },
  { name: "Rent", type: "expense", icon: "🏠" },
  { name: "Bills", type: "expense", icon: "💡" },
  { name: "Shopping", type: "expense", icon: "🛍️" },
  { name: "Entertainment", type: "expense", icon: "🎬" },
  { name: "Health", type: "expense", icon: "💊" },
  { name: "Education", type: "expense", icon: "📚" },
  { name: "Travel", type: "expense", icon: "✈️" },
  { name: "Salary", type: "income", icon: "💼" },
  { name: "Freelance", type: "income", icon: "💻" },
  { name: "Investment returns", type: "income", icon: "📈" },
  { name: "Gift received", type: "income", icon: "🎁" },
  { name: "IPO investment", type: "investment", icon: "🎯" },
  { name: "SIP investment", type: "investment", icon: "💧" },
  { name: "Mutual fund", type: "investment", icon: "📊" },
  { name: "Stocks", type: "investment", icon: "📈" },
  { name: "Loan given", type: "loan", icon: "🤝" },
  { name: "Loan taken", type: "loan", icon: "💳" },
  { name: "Repayment received", type: "income", icon: "💵" },
  { name: "Repayment made", type: "expense", icon: "💸" },
];
