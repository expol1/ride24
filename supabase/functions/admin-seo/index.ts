import { requireAdmin,serviceClient } from '../_shared/ride24-security.ts';
import { createSeoHandler } from './handler.ts';
Deno.serve(createSeoHandler({fetch,authorize:requireAdmin,service:serviceClient,env:(name)=>Deno.env.get(name)}));
