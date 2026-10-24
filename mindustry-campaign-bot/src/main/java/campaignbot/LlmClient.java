package campaignbot;

import arc.Core;
import arc.util.Http;
import arc.util.Log;
import arc.util.Time;

/**
 * Non-blocking transport of the Gemma 4 E2B brain: {@link Http#post} runs on Arc's own
 * thread pool, the answer is handed back to the game thread through {@link Core#app}.
 * Settings: {@code scb-llm-enabled}, {@code scb-llm-url}, {@code scb-llm-model}.
 * When Ollama is not running the callback gets {@code ok = false} and the bot silently
 * keeps using its built-in planner.
 */
public class LlmClient implements LlmBrain.Env{
    public static final String PREF_ENABLED = "scb-llm-enabled";
    public static final String PREF_URL = "scb-llm-url";
    public static final String PREF_MODEL = "scb-llm-model";

    @Override
    public boolean enabled(){
        return isEnabled();
    }

    public static boolean isEnabled(){
        try{
            return Core.settings == null || Core.settings.getBool(PREF_ENABLED, true);
        }catch(Throwable t){
            return true;
        }
    }

    public static void setEnabled(boolean on){
        try{
            if(Core.settings != null) Core.settings.put(PREF_ENABLED, on);
        }catch(Throwable ignored){
        }
    }

    private static String setting(String key, String def){
        try{
            if(Core.settings == null) return def;
            String v = Core.settings.getString(key, def);
            return v == null || v.isEmpty() ? def : v;
        }catch(Throwable t){
            return def;
        }
    }

    @Override
    public String url(){
        return setting(PREF_URL, LlmBrain.DEFAULT_URL);
    }

    @Override
    public String model(){
        return setting(PREF_MODEL, LlmBrain.DEFAULT_MODEL);
    }

    @Override
    public float now(){
        return Time.time / 60f;
    }

    @Override
    public void post(String url, String body, int timeoutMs, final LlmBrain.Callback cb){
        try{
            Http.HttpRequest req = Http.post(url, body);
            req.header("Content-Type", "application/json");
            req.timeout(timeoutMs);
            req.error(err -> postToGame(cb, false, String.valueOf(err)));
            req.submit(res -> {
                String text;
                try{
                    text = res.getResultAsString();
                }catch(Throwable t){
                    text = "";
                }
                postToGame(cb, true, text);
            });
        }catch(Throwable t){
            Log.debug("[serpulo-campaign-bot] llm post failed: @", t);
            postToGame(cb, false, String.valueOf(t));
        }
    }

    private static void postToGame(final LlmBrain.Callback cb, final boolean ok, final String text){
        if(Core.app == null){
            cb.done(ok, text);
            return;
        }
        Core.app.post(() -> cb.done(ok, text));
    }
}
