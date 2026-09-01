# Scene Weaver Accelerator

Clone this complete project and its already working perfectly without any issues. So run this completed project on our server.
https://github.com/janudi423-alt/scene-weaver-accelerator.git

https://www.pixazo.ai/models/
note:- pixazo api key is with 0 credits balance so make sure use only free ai model FLUX.1 Schnell.
https://paraloncloud.com/console api key :-


note:- paraloncloud.com api key is with 0 credits balance so make sure use only free ai models Qwen 3.8 27B Is Live: a Free, OpenAI-Compatible Vision (keep thinking mode disabled)

Changes you have to Complete project is working perfectly without any issues but Genrate one completed video taking too much time. 
Make sure I am Generating only large videos from script (1 script more than 100000 characters) (1 script will produce 2 hours+ video)make sure it handle workflow perfectly without reducing accuracy and quality.

Remaining
One TypeScript error left: src/routes/index.tsx line ~230 still referenced the old URL.createObjectURL(result) shape — my rewrite of that file was submitted but the build check didn't re-run, so it needs one verification pass (the new code returns { kind: "blob" | "file" }`).
Run the app end-to-end once (sample script → panels → video) to confirm the WebCodecs path encodes cleanly in the preview browser.
Tune image concurrency against the real per-key rate limit — at 23s/image and 16 in flight, ~1500 panels lands around 35–40 minutes; measuring actual limits per Pixazo key may allow going higher.

Pixazo api key 1
03178ba869a446eba82bce98a79fefc3

Pixazo api key 2
048e52aee2094e24bad1b46a0fb15753

Pixazo api key 3

d004a01679f843e7ba090fa1d88c926d

Pixazo api key 4
9379183b074f4655adc0fa351dd4fa29

Paraloncloud api key 1
prlc_667ae9e467f065c6202fc7e12f07f575a8111b7ad906dd73
Paraloncloud api key 2

prlc_99b14331acd49b119237bef2ecc2e1078ecdd0f3be8a83d7

Paraloncloud api key 3
prlc_a16ea589738ffd489a8c2bb8550facce032e2263922de645

Paraloncloud api key 4

prlc_9dec184306d8d0dbb7d12c98d6dc22ce35d5ac3feaf2ccb9

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://script-to-epic.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/d1db9cf5-a146-40ec-bce7-99d77c09f51a).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
