import {serviceClient} from '../_shared/ride24-security.ts';
import {createCallbackHandler} from './handler.ts';
Deno.serve(createCallbackHandler({service:serviceClient,fetch,env:(name)=>Deno.env.get(name)}));
