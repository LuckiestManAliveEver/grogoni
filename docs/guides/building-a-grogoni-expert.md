# Build a Grogoni Expert

You teach Grogoni by showing what correct work looks like. You do not need to choose training settings
or understand model engineering.

## 1. Create the expert

Name the job narrowly: “classify products,” “suggest reorder quantity,” or “match substitutes” is
better than “run my whole shop.” Choose the business and agent that should use it.

## 2. Define correct results

Give a few real examples, including awkward spelling, local vocabulary, missing units, and cases
where Grogoni must refuse or ask a question. Define the exact fields or business rules that matter.

## 3. Evaluate

Run the test set. The report card shows which examples passed, not just one score. Check correctness,
tool choice, output format, regressions, prompt size, and speed.

## 4. Use it

Promote only a candidate that passes your gates. Grogoni uses it through the normal agent and model
runtime. You may change the compatible base model later without losing your examples or history.

## 5. Correct a mistake

When Grogoni is wrong, mark the interaction as a suspected failure and write the answer that should
have been given. Keep only the input and business context needed to explain the correction. Do not
paste passwords, private conversations, or unrelated customer data.

## 6. Approve the correction

Review the correction before approval. An observed output is never automatically trusted. Approval
makes it eligible for a new dataset; it does not change production immediately.

## 7. Improve and compare

Create a frozen dataset version and start an improvement. Today Grogoni can genuinely optimize the
prompt and compile approved rules. Other strategy labels will tell you they are unavailable rather
than pretending to train a model. Evaluate the candidate against the current production version.

## 8. Promote or reject

Promote when the candidate improves the job without exceeding regression limits. Reject it when an
old correct case breaks, even if its prompt is shorter. If production behavior disappoints you,
roll back to the previous promoted version.

## 9. Publish later

An export contains the expertise manifest, source rules, prompt, lineage, and checksums. Marketplace
buyers can eventually compare demonstrated results and tested bases. The base model name alone is
not the product.

```text
Create -> Examples -> Evaluate -> Use -> Correct -> Approve
       -> Improve -> Compare -> Promote -> repeat
```
