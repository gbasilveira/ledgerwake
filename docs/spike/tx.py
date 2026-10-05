import json,sys,collections
types=collections.Counter(); keys=collections.defaultdict(set); blocks=collections.Counter(); versions=collections.Counter(); usage_keys=set(); think=[]
for p in sys.argv[1:]:
    for l in open(p):
        e=json.loads(l); t=e.get('type'); types[t]+=1; keys[t]|=set(e)
        if 'version' in e: versions[e['version']]+=1
        m=e.get('message')
        if isinstance(m,dict):
            c=m.get('content')
            if isinstance(c,list):
                for b in c:
                    blocks[(t,b.get('type'))]+=1
                    if b.get('type')=='thinking': think.append((len(b.get('thinking','')), 'signature' in b))
            elif isinstance(c,str): blocks[(t,'<string>')]+=1
            if m.get('usage'): usage_keys|=set(m['usage'])
print("entry types:",dict(types)); print("versions:",dict(versions))
for t,k in keys.items(): print(f" keys[{t}]:",sorted(k))
print("content blocks:",dict(blocks)); print("usage keys:",sorted(usage_keys)); print("thinking blocks (len,signed):",think[:5], len(think))
