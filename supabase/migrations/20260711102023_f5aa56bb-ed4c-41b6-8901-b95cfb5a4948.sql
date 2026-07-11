
ALTER TABLE public.action_runs DROP CONSTRAINT IF EXISTS action_runs_kind_check;
ALTER TABLE public.action_runs ADD CONSTRAINT action_runs_kind_check
  CHECK (kind IN (
    'broadcast','comment','reply','deleteMessages','edit','botFlow','botflow',
    'forward','reactions','viewBoost','joinLinks','profileUpdate','joinChannels',
    'react','vote','bulkMix','cleanup','leaveByLinks','mute','unmute','archive','unarchive','pin','unpin',
    'createChat','inviteToChat','dmBlast','editSent','copyClean','voiceNote','pollCreate','readAll'
  ));
