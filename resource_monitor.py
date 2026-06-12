import psutil, time, json, sys, os
def monitor(duration=120, interval=2, out='resource_log.json'):
    logs = []
    start = time.time()
    pids = []
    while time.time() - start < duration:
        cpu = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory().percent
        proc_info = []
        for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_info']):
            try:
                if 'python' in proc.info['name'].lower() or 'node' in proc.info['name'].lower() or 'kai' in proc.info['name'].lower():
                    proc_info.append({
                        'pid': proc.info['pid'],
                        'name': proc.info['name'],
                        'cpu': proc.info['cpu_percent'],
                        'mem_mb': proc.info['memory_info'].rss / (1024*1024) if proc.info['memory_info'] else 0
                    })
            except: pass
        log = {'t': time.time()-start, 'sys_cpu': cpu, 'sys_mem': mem, 'procs': proc_info}
        logs.append(log)
        print(json.dumps(log))
        time.sleep(interval)
    with open(out, 'w') as f: json.dump(logs, f, indent=2)
    print(f'Logged to {out}')
if __name__ == '__main__':
    monitor(int(sys.argv[1]) if len(sys.argv)>1 else 120)
