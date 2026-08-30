# Roadmap

## Server-side rendering migration (in progress)
- [ ] Move video encoding off the browser entirely (WebCodecs error must disappear)
- [ ] Render worker: Node + ffmpeg container, deployed on AWS (user hosts)
- [ ] Job queue table in Lovable Cloud (`render_jobs`) + status polling
- [ ] Server fn: create job, sign upload URL, dispatch to worker
- [ ] Worker: download panels -> ffmpeg Ken Burns + crossfades -> MP4 -> upload
- [ ] Delivery: finished MP4 in Cloud storage, signed download link in UI
- [ ] UI: replace in-browser encode flow with job progress + download

## Awaiting from user
- [ ] AWS worker public HTTPS URL
- [ ] Confirmation of instance size / region
