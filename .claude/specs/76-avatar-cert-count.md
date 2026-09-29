# Spec 76: The avatar says how many certifications he holds

Asked "how many certifications does he hold?", the Avatar said he holds three cloud certifications. It explained that only three are classified as cloud. He holds fourteen.

## Cause

`get_certifications` hands the Live model a list of fourteen entries, each with an `issuer` and a `category` tag (`ai`, `cloud`, `security`). Exactly three are tagged `cloud`. Left to count a list out loud, the model grabbed the one number the data seemed to offer and answered a narrower question than the one asked. The prompt already says cloud certifications are counted by issuer, but a prompt line lost to a field in the data.

## Change

- **`live_brain.py`:** the live dispatcher's result for `get_certifications` states the counts in its message (`cert_counts`): the total, the split by issuer, a line saying to lead with the total, and that `category` is a topic tag, not the vendor. The data is unchanged. The text agent's tool is unchanged too, since it didn't show this fault.

## Definition of done

- [x] `uv run pytest tests/unit` passes, with a test that the result states the total and the split by issuer.
- [x] A live `LiveConversation` run on Vertex: "How many certifications does he hold?" gives fourteen, and "how many of those are cloud certifications?" gives ten, by issuer.
- [ ] On the live site, the same question in Avatar mode gives the total.
