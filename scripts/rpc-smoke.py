#!/usr/bin/env python3
"""用 pi 的 RPC 模式无终端地跑一遍 pi-codearts 的命令与事件路径。

用法：python3 scripts/rpc-smoke.py [--model MODEL_ID]
只读接口（doctor / usage / models）不消耗积分；不发起对话。
"""
import json, subprocess, sys, time, threading, queue

model = "glm-5.3-flash"
if "--model" in sys.argv:
    model = sys.argv[sys.argv.index("--model") + 1]

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session", "--provider", "codearts", "--model", model],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
    cwd="/tmp",
)
lines: "queue.Queue[str]" = queue.Queue()
stderr: "queue.Queue[str]" = queue.Queue()

def pump(stream, q):
    for line in stream:
        q.put(line)
    q.put("")

threading.Thread(target=pump, args=(proc.stdout, lines), daemon=True).start()
threading.Thread(target=pump, args=(proc.stderr, stderr), daemon=True).start()

counter = 0
def send(cmd):
    global counter
    counter += 1
    cmd = {"id": f"r{counter}", **cmd}
    proc.stdin.write(json.dumps(cmd, ensure_ascii=False) + "\n"); proc.stdin.flush()
    return cmd["id"]

def wait_response(rid, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            line = lines.get(timeout=0.5)
        except queue.Empty:
            continue
        if line == "": raise SystemExit("pi 退出")
        try: obj = json.loads(line)
        except json.JSONDecodeError: continue
        if obj.get("type") == "response" and obj.get("id") == rid:
            return obj
    raise SystemExit(f"等待 {rid} 超时")

def drain(seconds):
    end = time.time() + seconds
    seen = []
    while time.time() < end:
        try:
            seen.append(json.loads(lines.get(timeout=0.3)))
        except queue.Empty:
            pass
        except json.JSONDecodeError:
            pass
    return seen

def custom_messages():
    rid = send({"type": "get_messages"})
    resp = wait_response(rid)
    out = []
    for m in resp["data"]["messages"]:
        if m.get("role") == "custom" or m.get("customType"):
            out.append(m)
    return out

print(f"pi pid={proc.pid} model=codearts/{model}")
rid = send({"type": "get_commands"}); resp = wait_response(rid)
names = [c["name"] for c in resp["data"]["commands"] if "codearts" in c["name"]]
print("① 扩展命令已注册:", names)

rid = send({"type": "get_state"}); resp = wait_response(rid)
print("② 当前模型:", resp["data"].get("model", {}).get("provider"), "/", resp["data"].get("model", {}).get("id"))

for cmd in ["/codearts-doctor", "/codearts-usage", "/codearts-models"]:
    before = len(custom_messages())
    rid = send({"type": "prompt", "message": cmd}); resp = wait_response(rid)
    disposition = resp["data"].get("disposition")
    # 等命令处理完成：最多轮询 20 秒直到出现新的 custom 消息
    for _ in range(40):
        time.sleep(0.5)
        msgs = custom_messages()
        if len(msgs) > before: break
    print(f"③ {cmd} → disposition={disposition}")
    if len(msgs) > before:
        content = msgs[-1].get("content")
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        print("   " + text.replace("\n", "\n   "))
    else:
        print("   （没有收到 custom 消息）")

time.sleep(1)
proc.stdin.close()
try: proc.wait(timeout=10)
except subprocess.TimeoutExpired: proc.kill()
errs = []
while True:
    l = stderr.get()
    if l == "": break
    if "pi-codearts" in l or "rror" in l: errs.append(l.rstrip())
print("④ stderr 中与扩展相关的行:")
for e in errs: print("   " + e)
if not errs: print("   （无）")
