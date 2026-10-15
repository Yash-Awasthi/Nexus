-- SPDX-License-Identifier: Apache-2.0
-- Migration 0022: memory entries name their owner in both places
--
-- The Memory page stored the owner in user_id and /api/v1/memory in metadata.userId, and each
-- filtered on its own field, so neither saw the other's entries. New writes carry both; this
-- fills in the missing half of rows written before.

UPDATE memory_entries
   SET user_id = metadata->>'userId'
 WHERE user_id IS NULL AND metadata ? 'userId';

UPDATE memory_entries
   SET metadata = metadata || jsonb_build_object('userId', user_id)
 WHERE user_id IS NOT NULL AND NOT (metadata ? 'userId');
