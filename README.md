# تسعير المراتب

موقع لحساب تكلفة وسعر بيع المراتب (طبي وسوست) من أسعار مكوناتها، لكل المقاسات.

- الموقع: https://shadyyasser.github.io/mattress-pricing/
- المالك بيعدّل المكونات والمراتب والإعدادات، وكل تعديل بيتحفظ لوحده.
- المشاهدين بيشوفوا سعر البيع (وسعر العروض لو مفعّل) بس.

## التقنية
- صفحة واحدة `site/index.html` من غير build، بتتنشر على GitHub Pages من `.github/workflows/deploy.yml`.
- قاعدة البيانات وتسجيل الدخول على Supabase (`mattress-pricing`)، والمخطط في `supabase/migrations/`.
- `.github/workflows/keepalive.yml` بيصحّي قاعدة البيانات كل 3 أيام عشان المشروع المجاني مايتقفلش.
