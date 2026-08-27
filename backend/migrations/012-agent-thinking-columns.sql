-- Gemini thought-summary token count and whether a turn produced visible
-- thinking. Raw thought text is never persisted — only this aggregate.
ALTER TABLE agent_interactions ADD COLUMN thinking_tokens INTEGER;
ALTER TABLE agent_interactions ADD COLUMN had_thinking     INTEGER;
