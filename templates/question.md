---
id: subj-nnn
version: "1"
subject: physics          # extensible label: mathematics, physics, chemistry, ...
answer_kind: numeric_unit  # single_choice | multi_choice | multi_blank | numeric_unit | expression | open
language: zh
tags: []
# Optional structured sub-questions (public labels only; points live in scoring):
# parts:
#   - label: "1"
#     prompt: "Find the acceleration."
# Optional inline choices (for choice questions); otherwise put them in the body:
# options:
#   A: "..."
#   B: "..."
---

# Question

Write the original question text here, faithfully. Keep formulas as LaTeX, e.g. $F = ma$.

Reference figures with a relative path; the file must exist next to this file (or in a subfolder):

![description of figure](figures/example.png)

For multi-part questions, list the sub-questions in the body too.
