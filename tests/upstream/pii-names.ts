// Name dictionary for the personal-data scrubber. Lowercase ASCII, de-duplicated at load.
// Coverage: common given names and surnames of US, UK, Hispanic, South Asian, East Asian, Arabic,
// African and European origin. Apostrophes and accents are stripped before lookup (O'Brien -> obrien).
// ponytail: a frequency list, not a census. Rare names are caught by cue rules or custom terms.

const set = (...lists: string[]) => new Set(lists.join(" ").split(/\s+/).filter(Boolean));

const GIVEN_EN_M = `james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark
donald steven paul andrew joshua kenneth kevin brian george edward ronald timothy jason jeffrey ryan jacob gary nicholas eric
jonathan stephen larry justin scott brandon benjamin samuel gregory frank alexander raymond patrick jack dennis jerry tyler aaron
adam henry nathan douglas zachary peter kyle walter ethan jeremy harold keith christian roger noah gerald carl terry sean austin
arthur lawrence jesse dylan bryan joe jordan billy bruce albert willie gabriel logan alan wayne roy ralph randy eugene vincent
russell elijah louis bobby philip johnny bradley shawn clarence travis craig stanley leonard todd curtis victor norman glenn
marvin martin ernest allen phillip earl francis fred howard jimmy danny dale cody darrell jeff derek chad marcus theodore mike lee
ricky troy randall barry bernard leroy micah isaac luke mason oliver liam lucas owen caleb connor hunter eli landon evan gavin
aiden jackson carter jayden wyatt sebastian julian levi isaiah colton dominic xavier ian cole blake adrian tristan chase cooper
parker miles max leo felix oscar hugo jasper theo harry alfie archie freddie charlie finley toby harvey reuben callum rhys ewan
angus hamish fergus alastair duncan graham nigel trevor clive colin desmond gareth geoffrey gordon neil simon stuart rupert giles
hugh cedric edmund edgar edwin elliot emmett everett ezra finn grady grant hank harrison heath ivan jared jarrod jonah josiah kurt
lance lloyd lowell lyle malcolm marshall maurice melvin milton mitchell morgan morris nathaniel neal nelson nolan omar otis percy
perry preston quentin quincy reginald rex rodney roland roman ross ruben rufus salvatore sheldon sidney silas spencer sterling
tanner terrence tobias tucker vernon wade warren wesley wilbur wilson winston zane brent brett brock bryce byron calvin cameron
clay clayton clifford clint clinton corey damon darren darryl dean devin dexter dustin dwayne dwight elliott elmer emanuel ervin
fabian floyd forrest garrett gilbert glen guy herbert herman homer horace irving jerome jody joel kelvin kendall kent kirk lamar
lester lewis lonnie luther mack marc marion marlon marty mathew merle monte murray ned noel norris orville pete rick rickey rob rod
rodger rudy sammy sherman stan stevie teddy tim tom tommy tony virgil wendell wilfred will willard zach zack brayden braxton
bentley greyson grayson hudson easton jaxon jameson kayden knox maverick nash ryder sawyer weston asher atticus beckett declan
dashiell emerson griffin holden jude kieran lachlan rowan bob bill ben dan dave don doug ed eddie gene greg jake jim joey jon josh
ken larry matt nate nick pat phil ray rich ron sam steve ted tod vince walt andy alex chris abe abel abraham alvin amos archer
ari arlo august axel barrett bennett boyd bradford brady brendan brennan brody bruno cade cary cash cecil chandler chester
clark claude cliff conrad cornelius cyrus dallas dalton dane darius darnell davis dawson deandre demetrius denzel deshawn desean
devon dillon donovan drake drew duane earnest eldon elias ellis elvis emery emil enoch errol ethan ferdinand fletcher ford
foster franklin frederick gage galen garfield garry gus hal hans harlan harley hayden hector hollis hubert hunter ike ira irwin
isaiah jackie jamal jarvis javon jaylen jefferson jermaine jessie jett jonas judd judson julius kareem keegan keenan kendrick
kenny kermit lane lars lawson leland lenny leon leonardo lincoln linus lionel lucian luis lyndon magnus major mario marquis
maxwell maynard mckinley merlin mervin mickey mort moses myron napoleon newton nicky niles noble odell ollie orlando osborne
oswald otto pierce porter prince quinn rashad reed reese reggie remington reynold rhett rocco rocky rory roscoe royce russ rusty
ryland sanford sawyer scottie seth shane shaun shelby skyler solomon sonny stefan sylvester tate terrell thaddeus thurman titus
trent trenton trey tyrone tyson ulysses van vance vaughn wallace ward waylon webster weldon wiley woodrow wyatt xander zachariah
zeke beau bodhi bowen brooks callan camden colby colt corbin crew cruz dax dean easton enzo finnegan ford gideon gunner hendrix
jace jagger jax kaiden kaleb kane killian king kingston kyler landry legend lennox luca maddox malachi milo nico oakley onyx
orion paxton phoenix pierce raiden remy rhodes ronan rylan saint sullivan sutton tatum thatcher titan tripp tristen walker wells
westin wilder zander zayden zion`;

const GIVEN_EN_F = `mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra ashley
kimberly emily donna michelle carol amanda dorothy melissa deborah stephanie rebecca sharon laura cynthia kathleen amy angela
shirley anna brenda pamela emma nicole helen samantha katherine christine debra rachel carolyn janet catherine maria heather diane
ruth julie olivia joyce virginia victoria kelly lauren christina joan evelyn judith megan andrea cheryl hannah jacqueline martha
gloria teresa ann sara madison frances kathryn janice jean abigail alice julia judy sophia grace denise amber doris marilyn
danielle beverly isabella theresa diana natalie brittany charlotte marie kayla alexis lori tiffany tammy crystal dawn erin tina
wendy tracy stacy stacey gina dana paula rita rosa april leslie connie carmen shannon robin sherry sylvia vanessa valerie veronica
monica holly jill kristen kristin kristina erica erika allison alyssa brianna brooke caitlin chelsea chloe claire courtney ella ava
mia zoe zoey lily lillian addison aubrey avery harper scarlett aria riley nora hazel ellie stella violet aurora savannah audrey
bella skylar lucy paisley caroline genesis kennedy sadie piper ruby eva naomi gabriella madelyn eleanor penelope layla camila
elena maya sophie isla freya poppy imogen amelia niamh siobhan aoife ciara orla saoirse fiona moira eilidh bronwyn gwen cerys
carys rhiannon gemma hayley kirsty kerry lorraine maureen nicola philippa pippa tamsin tracey yvonne zara agnes beatrice
bernadette bonnie bridget candace cassandra cecilia celeste charlene clara colleen constance cora daisy darlene deanna delia
delores desiree dolores edith edna eileen elaine eliza ellen eloise elsie esther ethel eunice faith faye felicia florence geneva
georgia geraldine gertrude gladys glenda gretchen gwendolyn harriet hattie hilda ida irene iris irma ivy jacquelyn jana jane
janelle janie janine jeanette jeanne jenna jenny jo joann joanna joanne jocelyn josephine joy juanita june kara kari kate katelyn
katie kay kelli kendra kerri krista kristi kristy lacey latoya leah lena leona lindsay lindsey lois lola loretta lorna louise
lucille lydia lynn mabel mae maggie mandy marcia margie marian marianne marjorie marlene marsha maxine meghan melanie melinda
melody mercedes meredith mildred mindy miranda miriam misty molly mona muriel myra myrtle nadine nell nellie nina noelle norma
olive opal patsy patty pauline pearl peggy penny phyllis priscilla ramona regina renee rhonda roberta rochelle rosalie rose
rosemary roxanne sally sheila shelia shelley shelly sheri sherri sonia sonya sue summer susie suzanne tabitha tamara tanya tara
terri thelma toni tonya tricia trisha velma vera verna vicki vickie vicky viola vivian wanda whitney wilma winifred yolanda
annabelle arabella adeline delilah josie willow ember juniper luna nova sage sloane tessa wren abby ada adele adrienne aileen
alana alexa alexandra alexandria alice alicia alison allie alma althea amara amie anastasia angelica angelina angie anita annette
annie antoinette ariana ariel arlene ashlee ashleigh athena autumn bailey barb becky belinda bernice bertha bessie beth bethany
betsy bettie beulah bianca billie blanche bobbie brandi brandy breanna bree brenna bridgette britney brittney brooklyn callie
camille candice cara carla carlene carly carlotta carol carole carolina carrie casey cassidy cassie cathy celia chandra chanel
charity charmaine chasity cherie cheyenne christa christie christy cindy claudette claudia cleo clementine coral cordelia corinne
cristina dahlia daphne darla deb debbie dee deirdre della delphine demi destiny diamond dianna dianne dixie dominique dora doreen
dottie ebony eden effie elisa elise elisabeth elissa elle elnora elva elvira emilia emmeline enid erma ernestine essie estelle
etta eugenia evangeline eve fannie fern flora flossie francesca francine frankie freda frieda gabrielle gail gayle genevieve
georgette georgina gillian ginger ginny giselle goldie gracie greta gwyneth hadley hailey haley hallie hanna harmony heidi helena
henrietta hester hillary hollie hope ilene ina inez ingrid iona isabel isabelle isadora ivory jackie jaclyn jade jami jamie jan
janae janette janis jasmine jayla jayne jeanie jeannette jeannie jemima jenifer jeri jessie jewel jewell jillian jodi jodie joelle
johanna joni jordyn josefa josette judi juliana julianne juliet justine kaitlin kaitlyn karla karina karyn kasey katharine kathie
kathy katrina kaylee keisha kellie kelsey kenya kiara kiera kira kirsten kitty kourtney kyla kylie lakeisha lana lara larissa
latasha laurel laurie laverne leanne leigh leila lenora leola lesley leticia libby lila lilly lina liz liza lizzie lora loraine
lorene lorie lottie lou luann lucinda lula lynda lynette lynne mackenzie madeline madge mamie mara marcella marcy margo margot
mariah maribel marietta marilee marina marissa marla marnie martina maryann maryanne marylou matilda mattie maude maura mavis
maya mckenna meg mellie mercy merle michaela michele mikayla millie minnie mira missy mitzi moira mollie monique myrna nan nanette
natasha nettie nichole nikki nita nola nona noreen octavia odessa ola olga ollie oprah paige pam pansy patrice pattie paulette
pearlie petra phoebe polly portia precious prudence queenie rae raven reba reva rhoda robyn rosalind rosalyn rosanna rosanne
roseann roslyn rowena roxie ruthie sabrina sasha selena selma serena shana shanna shari sharlene sharron shauna shawna sheena
shelby sheree sheryl sierra simone sondra stacie star starla stefanie sybil tameka tami tammie tasha tatiana tatum taylor teri
tess thea tia tiana tillie tisha tori tracie trina trinity trudy twila ursula val valencia velda venus verda vida vilma virgie
vonda willa willie wilda winnie xena yasmin yvette zelda zelma zena zola`;

const GIVEN_HISPANIC = `jose juan luis carlos jorge miguel pedro manuel francisco antonio jesus alejandro ricardo fernando roberto
eduardo javier sergio rafael mario raul enrique arturo alberto hector armando ramon julio cesar guillermo andres gerardo alfredo
pablo marco diego ernesto felipe salvador gustavo ignacio jaime rodrigo esteban emilio santiago mateo matias nicolas tomas joaquin
emiliano agustin benicio thiago bautista lorenzo maximiliano cristian cristobal gonzalo alvaro angel domingo efrain eugenio
federico fidel gilberto horacio humberto ismael lazaro leonel marcelo mauricio moises nestor octavio osvaldo rigoberto rogelio
rolando saul teodoro vicente guadalupe juana margarita josefina leticia francisca alejandra silvia ana sofia valentina valeria
mariana daniela luciana ximena renata natalia jimena catalina fernanda paola lucia pilar esperanza consuelo beatriz blanca araceli
marisol lourdes rocio yesenia xiomara graciela guillermina lidia luz magdalena raquel rebeca rosario susana estela ines liliana
lorena noemi perla rosalba soledad adolfo adan agapito anselmo aurelio baltazar benito bernardo camilo candido clemente cruz
dario edgardo eliseo eloy epifanio evaristo ezequiel facundo fausto feliciano fermin florencio gaspar genaro german heriberto
hernan hilario hipolito isidro jacinto jeronimo leandro leopoldo lisandro luciano macario marcelino marcial mariano maximino
melchor modesto nicanor noe norberto pascual patricio paulino placido porfirio primitivo ramiro raymundo reinaldo renato reynaldo
rosendo rufino sabino samuel santos silvestre simon tadeo tiburcio ulises valentin wilfredo adela adelaida agustina amalia amparo
anabel angeles antonia asuncion aurelia aurora barbara belen benita bernarda brigida candelaria caridad celia clara concepcion
dulce edelmira elba elvia emilia encarnacion ernestina eulalia evangelina fabiola felicitas fidelia flor genoveva gregoria
herminia hortensia imelda irene itzel ivonne jacinta jovita juliana julieta leonor leonora lilia lola lupita macarena manuela
marcela maricela marta matilde maximina micaela milagros mireya nayeli nicolasa nieves ofelia olivia paloma paz petra piedad
ramona refugio remedios reyna rosalia rosalinda rosaura sagrario teodora tomasa trinidad veronica vicenta violeta virginia
yadira yaneth yolanda zoila zulema`;

const GIVEN_SOUTH_ASIAN = `aarav vivaan aditya vihaan arjun sai reyansh ayaan krishna ishaan rohan rahul amit anil sunil vijay
sanjay rajesh ramesh suresh mahesh dinesh ganesh mukesh rakesh naresh ashok ajay vikram vikas vivek vinod manoj deepak pankaj
sandeep sachin saurabh gaurav nikhil nitin kunal karan varun tarun arun kiran pavan praveen prakash pradeep rajiv ravi mohan gopal
hari harish girish satish umesh yogesh anand abhishek aniket ankit akash akshay ashish harsh mayank mohit neeraj piyush prateek
rohit shubham siddharth tushar utkarsh yash dev dhruv kabir shaan zain imran irfan salman shahid tariq wasim farhan faisal bilal
hamza usman asif arif priya pooja neha anjali divya kavita sunita anita geeta gita sita lakshmi lata asha usha rekha meena seema
reena sushma shobha savita jyoti swati shweta sneha shruti shreya riya diya aditi ananya aisha aishwarya deepika kareena
madhuri nandini padma parvati radha rani sangeeta sarita shanti sonal sonali tanvi vandana vidya yamini fatima ayesha sana saira
nadia rubina shabnam amrita harpreet gurpreet manpreet jaspreet simran navdeep kuldeep sukhdeep baljit manjit ranjit amarjit
sanjiv rajendra narendra surendra mahendra devendra jitendra abhinav abhijit ajit alok amar amitabh anirudh anupam arnav arvind
ashwin atul balaji bharat bhaskar chandra chetan chirag darshan dilip gautam govind hemant hitesh hrithik indra jagdish jai
jatin jayesh kailash kalpesh kamal kartik kishore lalit lokesh madhav mahavir manish mihir milind mitesh mukul murali nagesh
nakul naveen nilesh nirav nishant paresh parth pranav prasad prashant pratik prem puneet raghav raj rajan rajat rajeev raju
rakshit ranveer ritesh rupesh sagar sahil sameer samir sanket santosh sarvesh shailesh shankar sharad shashank shekhar shiv
shivam shyam sohan sourav srinivas subhash sudhir sumit suraj swapnil tanmay tejas uday ujjwal venkat vimal vinay vineet vipul
vishal yuvraj zubin akanksha alka amisha ankita anushka aparna archana arpita arti bhavna chitra damini dipti ekta garima gauri
hema indira isha jaya juhi kajal kalpana kamala kanika komal kriti lavanya leela madhu mala mamta manisha mansi meera megha minal
mira monika mridula namrata nikita nisha nita pallavi payal poonam prachi pragya preeti prerna priyanka purnima rachna radhika
rashmi renu richa ritu roshni ruchi rupa sadhna sakshi sapna shalini sharmila sheetal shilpa shivani smita sudha suman sunaina
supriya surbhi tanuja tara tina uma urmila urvashi varsha veena vineeta zoya`;

const GIVEN_EAST_ASIAN = `wei fang jing min lei yan jun ying hui xin yu ping hong bo tao chao gang hao jie kai lin ming peng qiang
rui tian xiang yang yong zhen zhi jian guo hua xiaoming xiaoli mei ling lan xia qing yun hiroshi takashi kenji yuki haruto yuto
sota ren hinata sakura yui aoi akira daiki kaito riku sho takumi tsubasa yuma haruka misaki nanami ayaka miyu rina saki mai emi
keiko yoko naoko tomoko akiko yumiko noriko kazuko sachiko masako junko hideo isamu kazuo minoru noboru satoshi shigeru tadashi
takeshi tetsuya toshio yoshio daisuke kenta naoki ryo shota taro jiro ichiro minjun seoyeon jiwoo jisoo jimin jihoon sungmin hyun
woo jin soo eun hye kyung sun hee anh minh tuan hung dung linh huong thu trang phuong thao hoa nga quang duc thanh hieu khanh
nam binh cuong vinh xiaoyan xiaohong xiaojun jianguo jianhua guoqiang zhiwei zhiqiang haiyan lihua liping meiling yuming
weiming wenjie yifan zihan yuxuan haoran zixuan yuhan mengyao xinyi jiayi kazuki ryota shun hayato kota ryusei yamato sora
hina mio rin yuna honoka airi kaede mei momoka natsuki chihiro kaori kumiko mayumi megumi michiko midori reiko satomi shizuka
sumiko takako yukiko yoshiko katsuo kiyoshi makoto masaru osamu susumu yutaka seojun hajun doyun siwoo jiho yejun junseo minseo
seoyun hayoon jiyoon chaewon yuna sooyoung jihye minji eunji hyejin jiyeon donghyun sanghoon jaehyun taeyang youngjae thuy
ngoc bich diem kim loan oanh quyen tam tien tuyet yen bao dat hai hoang khoa kien lam loc nghia phat phuc son tai thang
thinh tin toan tri trung viet`;

const GIVEN_ARABIC = `mohammed mohammad muhammad mohamed ahmed ahmad ali umar hassan hussein hussain ibrahim ismail yusuf youssef
khalid khaled abdullah abdul abdulrahman rashid said saeed salim saleh sami walid yasin yasser zaid ziad karim jamil hamid
hakim nasser nabil mustafa mahmoud majid malik mansour marwan fahad farid amir anwar ayman bashir adnan aya amina amal asma dalia
dina farah hana hala huda iman leila maha mariam maryam noor nour rana rania reem salma samira yasmine zahra zainab zeinab khadija
latifa lubna nawal rasha sahar shadia soraya suha abbas abdelaziz abdulaziz adel akram amin ammar anas aziz badr bakr basel
bassam daoud emad fadi fares fawzi ghassan habib hadi haitham hani harun hatem hisham idris imad issa jaber jalal kamal kamil
khalil luay maher mazen mehdi munir murad nader naji nizar osama qasim rafiq raed rami ramzi riad saad sabri salah salem
shadi sharif suleiman taha talal tamer tarek wael waleed yahya yazan younes zakaria zaki abeer afaf ahlam alia amani amira
arwa aziza basma bushra dunya eman fadwa fatin ghada hanan haneen hayat hiba ibtisam inas jamila jumana karima lama lamia
layal lujain mai manal marwa mayada mona muna nada nadine nahla najwa nisreen nuha rabab raghad randa rawan rima ruba ruqayya
sabah safa safiya sawsan shaima shireen siham sumaya tahani wafa widad yara yusra zaina`;

const GIVEN_AFRICAN = `kwame kofi kwasi kojo yaw kwabena ama akua abena adwoa afia chinedu chukwuemeka emeka obinna ikechukwu nnamdi
uchenna chidi chioma ngozi nkechi adaeze amaka ifeoma oluwaseun olumide babatunde ayodele adebayo folake funmilayo yetunde
temitope tunde segun femi kunle bola bukola titilayo abimbola olusegun thabo sipho themba bongani mandla sibusiso nkosana lerato
thandiwe nomvula zanele busisiwe nokuthula palesa tumelo kagiso kamau wanjiru njeri wambui otieno achieng akinyi baraka juma amani
zuri imani nia jabari tendai tatenda farai chipo rudo tafadzwa abebe tesfaye haile selam meron bethlehem sekou mamadou ousmane
ibrahima fatou aminata mariama awa moussa abdoulaye idrissa adaobi adanna adeola adetokunbo adunni akin akintunde ayo ayomide
azubuike chiamaka chibuzo chidera chidinma chiemeka chika chinonso chinwe chinyere chukwudi damilola ebele ebuka efosa ejike
ekene enitan eniola ifeanyi ifunanya ikenna jide kelechi kemi lanre modupe ndidi nkem nneka nonso obiageli obioma ogechi
olabisi olamide olufemi oluwadamilare oluwatobi omolara onyeka onyinye osagie sade simisola tobi tolu uche udoka ugochi
uzoma yemi zainabu akosua esi efua kwaku kwadwo nana nii adjoa afua akwasi araba ekow fiifi kobina mawuli selorm senam
ayanda bheki dumisani jabulani khanyisile lindiwe lungile mpho naledi nandi nokwanda nomsa nonhlanhla ntombi sandile sizwe
thandeka thulani vusi xolani zodwa zola barasa chebet cherono jelagat kibet kiprop kipchoge koros mumbi muthoni nyokabi
wairimu wangari atieno adhiambo awino onyango omondi okoth abdi asha faduma hodan hawa ifrah khadra sahra warsame`;

const GIVEN_EUROPEAN = `hans klaus jurgen wolfgang dieter helmut gunter gunther heinz karl fritz franz josef johann matthias andreas
florian lukas maximilian niklas jan sven nils bjorn erik olaf anders henrik mikael johan gustav oskar viktor mats per ole knut
harald sigurd leif torsten astrid sigrid freja helga monika sabine renate brigitte gisela anja katja tanja silke ulrike birgit
karin kerstin annika linnea elsa saga maja ebba pierre jacques michel philippe alain francois henri laurent luc marcel olivier
pascal rene thierry yves antoine baptiste etienne guillaume julien mathieu maxime remi sebastien jules francoise nathalie
sylvie lea manon amelie aurelie celine elodie juliette margaux giovanni giuseppe luigi francesco angelo vincenzo pietro carlo
franco domenico paolo stefano alessandro luca matteo davide federico riccardo giulia chiara sara giorgia alessia giovanna dmitri
dmitry sergei sergey alexei alexey andrei nikolai mikhail vladimir boris igor oleg yuri pavel maxim anton kirill artem denis
evgeny konstantin svetlana irina ekaterina yulia daria ksenia polina oksana ludmila galina piotr krzysztof andrzej tomasz pawel
marcin michal jakub mateusz wojciech zbigniew stanislaw kazimierz agnieszka katarzyna malgorzata ewa dorota beata jiri petr
ondrej vaclav milan zoltan laszlo istvan gabor attila ferenc nikos giorgos yannis kostas eleni katerina joao tiago rui nuno
goncalo willem pieter jeroen bas daan sem lotte sanne femke anouk niels mehmet ahmet emre burak can cem deniz elif zeynep ayse
fatma emine hatice achim adalbert albrecht alois arne bernd bodo burkhard christoph detlef eberhard eckhard egon erwin
friedrich georg gerd gerhard gottfried gregor hartmut heiko heinrich helge holger horst ingo joachim jochen jorg kai konrad
lothar lutz manfred markus norbert ralf reinhard rolf rudiger siegfried stephan thorsten udo ulrich uwe volker werner wilhelm
anneliese antje barbel christa dagmar edeltraud elfriede elke erika friederike gabriele gerda gertrud hannelore heike helene
ilse ingeborg irmgard jutta kathe liesel lieselotte margarete marlies mechthild ortrud rosemarie sieglinde waltraud wiebke
adrien alexandre arnaud aurelien benoit cedric christophe clement damien didier dominique edouard emmanuel fabien fabrice
florent frederic gael gaston gautier gerard gilles gregoire jeremie jerome joel lucien ludovic marc mathis maurice mickael
noel patrice quentin raphael regis romain serge stephane sylvain tristan valentin xavier yann yannick agathe anais angelique
apolline axelle benedicte brigitte capucine chantal charlotte clemence coralie corinne delphine eloise emilie estelle eugenie
fabienne florence gaelle helene jacqueline josephine justine laetitia laure lucie madeleine maelle marguerite marion mathilde
melanie mireille oceane odette odile pauline perrine sandrine severine solene veronique virginie alberto aldo alessio
alfonso amedeo antonello armando arturo attilio aurelio bernardo camillo carmine cesare claudio corrado cosimo cristiano
daniele dario edoardo elio emanuele enrico ettore fabio fabrizio filippo flavio gaetano gennaro giacomo gianluca gianni
gino giorgio graziano guido jacopo leonardo lorenzo luciano marcello massimo maurizio michele nicola nino orazio ottavio
pasquale piero raffaele renzo rocco ruggero sandro silvio tommaso umberto valerio vittorio alessandra annalisa annamaria
antonella arianna beatrice benedetta bianca carla carlotta caterina cinzia claudia concetta cristina daniela debora donatella
eleonora elisabetta emanuela federica fiorella gabriella ginevra giada graziella ilaria lorenza lucrezia ludovica maddalena
marisa michela nicoletta ornella patrizia raffaella rosalba rossella serena simona tiziana valentina vittoria aleksandr
aleksei anatoly arkady bogdan fyodor gennady grigory ilya leonid matvei nikita ruslan semyon stanislav timofey timur vadim
valentin valery vasily vitaly vsevolod vyacheslav yaroslav yegor alina alla anzhelika darya elizaveta inna kira klara
kristina larisa lidiya lyubov marina nadezhda nina raisa sofiya tamara ulyana valentina valeriya varvara vera veronika viktoriya
yana zhanna zinaida adam aleksander bartosz bogdan boleslaw czeslaw damian dariusz dawid dominik grzegorz henryk jacek janusz
jaroslaw jerzy karol lech leszek lukasz maciej marek mariusz miroslaw przemyslaw radoslaw rafal ryszard slawomir szymon
tadeusz waldemar wieslaw witold zdzislaw zygmunt aleksandra alicja aneta bozena danuta edyta elzbieta emilia grazyna halina
iwona izabela jadwiga jolanta justyna karolina kinga krystyna marta marzena paulina renata sylwia teresa urszula wanda
weronika wioletta zofia zuzanna anders birger bo borje christer goran gunnar hakan ingemar ingvar jens jorgen kjell lennart
mads morten oddvar oystein preben roar rune stig svein terje tor tore trond ulf vidar agneta anneli berit bodil britt
camilla cecilie dagny eva gunilla hanne hedda hilde inger ingeborg jorunn kari kirsten lena lise liv margit marit mette
ragnhild randi signe siri solveig sissel tone tove turid unni vigdis aleksi antti eero eino esa hannu heikki ilkka jari
jouni juha jukka kalle kari lauri markku matti mika mikko olli pekka petri risto sami seppo tapio teemu timo tuomas veikko
ville aino anneli eeva elina hanna heli helmi johanna kaisa leena liisa maarit marja merja minna paivi pirjo riitta ritva
sanna sari satu sirpa tarja tiina tuula afonso bernardo duarte eduardo filipe francisco gaspar guilherme gustavo henrique
jorge lourenco luis manuel martim miguel paulo rafael ricardo rodrigo rui salvador simao tomas vasco vicente ana beatriz
carolina catarina constanca diana francisca ines joana leonor madalena margarida mariana matilde rita sofia teresa arda
baris berk bulent cengiz efe engin erdem ercan erkan gokhan hakan halil hasan huseyin ilker kaan kemal kerem koray levent
mert metin murat onur orhan osman ozan ozgur selim serkan sinan tolga tuncay ugur umut volkan yasin yusuf asli aylin aysun
bahar basak burcu canan damla derya dilek ebru ece eda esra funda gamze gizem gul gulsen hande hulya irem meltem merve
nesrin nur ozge ozlem pinar seda selin sevgi sibel tuba tugba yasemin yeliz zehra`;

const SURNAMES_EN = `smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez gonzalez wilson anderson
thomas taylor moore jackson martin lee perez thompson white harris sanchez clark ramirez lewis robinson walker young allen king
wright scott torres nguyen hill flores green adams nelson baker hall rivera campbell mitchell carter roberts gomez phillips evans
turner diaz parker cruz edwards collins reyes stewart morris morales murphy cook rogers gutierrez ortiz morgan cooper peterson
bailey reed kelly howard ramos kim cox ward richardson watson brooks chavez wood james bennett gray mendoza ruiz hughes price
alvarez castillo sanders patel myers long ross foster jimenez powell jenkins perry russell sullivan bell coleman butler henderson
barnes gonzales fisher vasquez simmons romero jordan patterson alexander hamilton graham reynolds griffin wallace moreno west cole
hayes bryant herrera gibson ellis tran medina aguilar stevens murray ford castro marshall owens harrison fernandez mcdonald woods
washington kennedy wells vargas henry chen freeman webb tucker guzman burns crawford olson simpson porter hunter gordon mendez
silva shaw snyder mason dixon munoz hunt hicks holmes palmer wagner black robertson boyd rose stone salazar fox warren mills meyer
rice schmidt garza daniels ferguson nichols stephens soto weaver ryan gardner payne grant dunn kelley spencer hawkins arnold pierce
vazquez hansen peters santos hart bradley knight elliott cunningham duncan armstrong hudson carroll lane riley andrews alvarado ray
delgado berry perkins hoffman johnston matthews pena richards contreras willis carpenter lawrence sandoval guerrero george chapman
rios estrada ortega watkins greene nunez wheeler valdez harper burke larson santiago maldonado morrison franklin carlson austin
dominguez carr lawson jacobs obrien lynch singh vega bishop montgomery oliver jensen harvey williamson gilbert dean sims espinoza
howell li wong reid hanson le mccoy garrett burton fuller wang weber welch rojas lucas marquez fields park yang little banks
padilla day walsh bowman schultz luna fowler mejia davidson acosta brewer may holland juarez newman pearson curtis cortez douglas
schneider joseph barrett navarro figueroa keller avila wade molina stanley hopkins campos barnett bates chambers caldwell beck
lambert miranda byrd craig ayala lowe frazier powers neal leonard gregory carrillo sutton fleming rhodes shelton schwartz norris
jennings watts duran walters cohen mcdaniel moran parks steele vaughn becker holt deleon barker terry hale leon hail benson haynes
horton miles lyons pham graves bush thornton wolfe warner cabrera mckinney mann zimmerman dawson lara fletcher page mccarthy love
robles cervantes solis erickson reeves chang klein salinas fuentes baldwin daniel simon velasquez hardy higgins aguirre lin
cummings chandler sharp barber bowen ochoa dennis robbins liu ramsey francis griffith paul blair oconnor cardenas pacheco cross
calderon quinn moss swanson chan rivas khan rodgers serrano fitzgerald rosales stevenson christensen manning gill curry mclaughlin
harmon mcgee gross doyle garner newton burgess reese walton blake trujillo adkins brady goodman roman webster goodwin fischer huang
potter delacruz montoya todd wu hines mullins castaneda malone cannon tate mack sherman hubbard hodges zhang guerra wolf valencia
saunders franco rowe gallagher farmer hammond hampton townsend ingram wise gallegos clarke barton schroeder maxwell waters logan
camacho strickland norman person colon parsons frank harrington glover osborne buchanan casey floyd patton ibarra ball tyler suarez
bowers orozco salas cobb gibbs andrade bauer conner moody escobar mcguire lloyd mueller hartman french kramer mcbride pope lindsey
velazquez norton mccormick sparks flynn yates hogan marsh macias villanueva zamora pratt stokes owen ballard lang brock villarreal
charles drake barrera cain patrick pineda burnett mercado santana shepherd bautista ali shaffer lamb trevino mckenzie hess olsen
cochran morton nash wilkins petersen briggs shah roth nicholson holloway lozano flowers rangel hoover arias short mora valenzuela
bryan meyers weiss underwood bass greer summers houston carson morrow clayton whitaker decker yoder collier zuniga carey wilcox
melendez poole roberson larsen conley davenport copeland massey lam huff rocha cameron jefferson hood monroe anthony pittman huynh
randall singleton kirk combs mathis christian skinner bradford richard galvan wall boone kirby wilkinson bridges bruce atkinson
velez meza roy vincent york hodge villa abbott allison tapia gates chase sosa sweeney farrell wyatt dalton horn barron phelps yu
dickerson heath foley atkins mathews bonilla acevedo benitez zavala hensley glenn cisneros harrell shields rubio choi huffman boyer
garrison arroyo bond kane hancock callahan dillon cline wiggins grimes arellano melton oneill savage ho beltran pitts parrish ponce
rich booth koch golden ware brennan mcdowell marks cantu humphrey baxter sawyer clay tanner hutchinson kaur berg wiley gilmore
russo villegas hobbs keith wilkerson ahmed beard mcclain montes mata rosario vang walter henson oneal mosley mcclure beasley
stephenson snow huerta preston vance barry johns eaton blackwell dyer prince macdonald solomon guevara stafford english hurst
woodard cortes shannon kemp nolan mccullough merritt murillo moon salgado strong kline cordova barajas roach rosas winters jacobson
lester knox bullock kerr leach meadows davila orr whitehead pruitt kent conway mckee barr david dejesus marin berger mcintyre
blankenship gaines palacios cuevas bartlett durham dorsey mccall odonnell stein browning stout lowery sloan mclean hendricks
calhoun sexton chung gentry hull duarte ellison nielsen gillespie buck middleton sellers leblanc esparza hardin bradshaw mcintosh
howe livingston frost glass morse knapp herman stark bravo noble spears weeks corona frederick buckley mcfarland hebert enriquez
hickman quintero randolph schaefer walls trejo house reilly pennington michael conrad giles benjamin crosby fitzpatrick donovan
mays mahoney valentine raymond medrano hahn mcmillan small bentley felix peck lucero boyle hanna pace rush hurley harding mcconnell
bernal nava ayers everett ventura avery pugh mayer bender shepard mcmahon landry case sampson moses magana blackburn dunlap gould
duffy vaughan herring mckay espinosa rivers farley bernard ashley friedman potts truong costa correa blevins nixon clements fry
delarosa best benton lugo portillo dougherty crane haley phan villalobos blanchard horne finley quintana lynn esquivel bean dodson
mullen xiong hayden cano levy huber richmond moyer lim frye sheppard mccarty avalos booker waller parra woodward jaramillo krueger
rasmussen brandt peralta donaldson stuart faulkner maynard galindo coffey estes sanford burch maddox vo oconnell vu andersen spence
mcpherson church schmitt stanton leal cherry compton dudley sierra pollard alfaro hester proctor lu hinton novak good madden mccann
terrell jarvis dickson reyna cantrell mayo branch hendrix rollins rowland whitney duke odom daugherty travis tang archer whitfield
davies fraser mackenzie sutherland sinclair mcgregor ashworth barlow bradbury braithwaite butterworth clegg dewhurst entwistle
fairclough greenwood hargreaves holroyd kershaw ogden ramsbottom sutcliffe thornley winterbottom beckham gallacher docherty
mcallister mcleod mckinnon paterson ritchie thomson urquhart llewellyn pritchard bevan probert vaughan gough hussain begum
okafor whitlock whitmore whittaker pemberton prescott radcliffe redfern rowbotham shackleton sheridan shipley stanhope tomlinson
underhill wainwright wakefield warburton whitworth wolstenholme yardley`;

const SURNAMES_SOUTH_ASIAN = `kumar sharma gupta mehta verma reddy rao nair iyer menon pillai joshi desai kapoor malhotra chopra
agarwal aggarwal bansal goel jain mittal sinha mishra pandey tiwari trivedi dubey chaudhary chowdhury choudhury banerjee
mukherjee chatterjee bhattacharya ghosh bose das dutta sen saha sarkar biswas naidu chaudhry malik sheikh siddiqui qureshi
ansari mirza baig butt bhatt bhatia arora anand bajaj bedi dhillon grewal sandhu sidhu randhawa sodhi thakur yadav rajan krishnan
subramanian venkatesh srinivasan raman natarajan fernando perera dsouza fernandes pinto gomes rodrigues ahluwalia bhardwaj
bhasin chadha chawla dhawan dua gandhi gill goswami goyal grover iyengar jaiswal jha kapur khanna khurana kohli kulkarni
lal mahajan mathur modi nagpal narang oberoi pathak rastogi rathore sahni saini saxena sehgal sethi shetty shukla sodhi
solanki srivastava suri tandon taneja thapar tyagi vohra wadhwa walia zaveri akhtar aslam chaudhri farooqui hashmi iqbal
jamil javed kazmi mahmood naqvi nawaz raza rizvi saleem shaikh zaidi rahman hossain islam uddin miah karim amarasinghe
bandara dissanayake gunawardena jayasuriya jayawardena wickramasinghe adhikari bhattarai gurung karki shrestha tamang thapa`;

const SURNAMES_EAST_ASIAN = `zhao zhou xu sun ma zhu hu guo he gao luo zheng liang xie song han feng deng cao peng zeng xiao tian
dong pan yuan cai jiang du ye cheng wei su ding ren yao shen zhong cui tan fan liao shi jin cheung lau leung ng chow yeung tam
tsang kwok chu sato suzuki takahashi tanaka watanabe ito yamamoto nakamura kobayashi kato yoshida yamada sasaki yamaguchi saito
matsumoto inoue kimura hayashi shimizu yamazaki mori abe ikeda hashimoto ishikawa ogawa okada hasegawa fujita goto okamoto
murakami kondo ishii sakamoto endo aoki fujii nishimura fukuda ota miura fujiwara jung kang cho yoon jang oh seo shin kwon hwang
ahn yoo hong hoang dang bui do ngo duong ly bai chang fu gong gu hou jia kong lei long lv mao meng mo qian qin qiu shao tao
wan xiong xue yin zou fong kwan lai lo mak mok poon siu szeto tse tsui wan yip yuen maeda fujimoto nakajima ishida ueda
morita hara shibata sakai kudo yokoyama miyazaki miyamoto uchida takagi ando taniguchi ohno maruyama imai takada fujisawa
kojima kubo noguchi matsui chiba iwasaki sakurai kinoshita nomura kikuchi sano onishi sugiyama arai baek chae chun heo jeon
jeong ji ko moon nam noh ryu seong son woo yang yeo cao dinh doan ha luong mai quach ta thai to trinh truong vuong`;

const SURNAMES_ARABIC = `hassan hussein ibrahim khalil mahmoud mohamed mustafa omar saleh salem yousef abdullah haddad khoury nasser
najjar mansour hamdan farah darwish bakr aziz karimi hosseini ahmadi mohammadi rezaei moradi jafari sadeghi elmasri abbas amin
awad bashir habib hakim hamid issa jaber kassem khalaf mubarak qasim rashed sabry shaheen suleiman taha zaki alavi almasri
alfarsi alhashimi aljaber alkhatib almutairi alnajjar alotaibi alqahtani alrashid alsaadi alshammari alzahrani ayoub azizi
barakat bishara boutros daher dajani elamin elsayed fakhoury ghanem hariri husseini jaziri kanaan karam khatib maalouf
masri nassar odeh qureshi rahimi sabbagh safar salameh sayegh shami sharif tahir tawil yasin zaheer zidan akbari
bagheri ebrahimi ghorbani hashemi heidari kazemi mahdavi mousavi najafi rahmani rostami salehi shirazi tehrani`;

const SURNAMES_AFRICAN = `okonkwo okeke eze nwosu obi adeyemi adeleke ogunleye ogunbanjo olawale balogun bello abubakar musa mensah
owusu boateng asante appiah osei agyeman amoah addo ansah mwangi ochieng njoroge kariuki mutua odhiambo nyambura dlamini nkosi
ndlovu zulu khumalo mokoena mahlangu sithole ngcobo mthembu zuma mbeki tutu mandela diallo traore keita toure diop ndiaye sow
cisse camara kone coulibaly sesay kamara bangura conteh bekele girma kebede mugabe moyo ncube dube sibanda banda phiri mwale tembo
achebe adebisi adegoke adekunle adesina afolabi agbaje ajayi akande akinola akintola alabi aluko amadi aneke animashaun
anyanwu awolowo ayodeji azikiwe chukwu ekwueme emenike ezeh fashola ibekwe igwe ikpeazu iwu madu nnadi nwachukwu nwankwo
obasanjo odukoya ogbonna ogunbiyi ojo okoro okoye okpara olatunji oluwole onuoha onyeama opara oyelaran soyinka uzor
acheampong adjei agyei amankwah annan antwi asamoah baah bonsu darko frimpong gyamfi kuffour nkrumah ofori opoku quaye sarpong
tetteh wiredu kiplagat kipkemboi koech korir langat mutai ngugi nyaga omondi ouma rotich wafula wekesa chikwanha chirwa
gumede hadebe mabuza madonsela mahlaba makhanya maseko mazibuko mbatha mkhize molefe motaung msimang mtshali ngubane
nxumalo radebe shabalala shezi tshabalala zwane bah barry balde fofana konate sacko sangare sidibe sylla tall bamba
gueye mbaye niang sarr seck thiam wade abera alemu asfaw ayele demissie gebre getachew hailu lemma mekonnen mulugeta negash
tadesse tefera wolde yohannes mohamud warsame farah jama`;

const SURNAMES_EUROPEAN = `muller schneider schulz hoffmann schafer richter schroder neumann schwarz zimmermann braun kruger hofmann
hartmann lange werner krause meier lehmann schmid schulze maier kohler herrmann konig kaiser fuchs scholz moller jung schubert
vogel friedrich gunther winkler lorenz baumann franke albrecht schuster ludwig bohm winter kraus schumacher dubois petit durand
leroy moreau lefebvre bertrand roux fournier morel girard andre lefevre mercier dupont bonnet legrand garnier faure rousseau blanc
guerin roussel perrin morin mathieu clement gauthier dumont fontaine chevalier rossi ferrari esposito bianchi romano colombo
ricci marino greco bruno gallo conti deluca mancini giordano rizzo lombardi moretti barbieri fontana santoro mariani rinaldi
caruso ferrara galli martini leone longo gentile martinelli vitale lombardo serra coppola desantis dangelo marchetti parisi
conte ferraro ferri fabbri bianco marini grasso valentini messina sala deangelis gatti pellegrini palumbo sanna farina rizzi monti
cattaneo morelli amato silvestri mazza testa grassi pellegrino carbone giuliani benedetti barone rossetti caputo montanari
palmieri bernardi martino fiore derosa ferretti bellini basile riva donati piras vitali battaglia sartori neri costantini milani
pagano ruggiero sorrentino damico orlando damato ivanov smirnov kuznetsov popov vasiliev petrov sokolov mikhailov novikov fedorov
morozov volkov alekseev lebedev semenov egorov pavlov kozlov stepanov nikolaev orlov andreev makarov nikitin zakharov nowak
kowalski wisniewski wojcik kowalczyk kaminski lewandowski zielinski szymanski wozniak dabrowski kozlowski jankowski mazur
kwiatkowski krawczyk svoboda novotny dvorak cerny prochazka horvath nagy kovacs toth szabo varga kiss molnar nemeth farkas balogh
papp takacs juhasz popescu ionescu popa radu dumitru stoica gheorghe papadopoulos georgiou dimitriou nikolaidis jansen devries
vandenberg vandijk bakker janssen visser smit meijer deboer mulder degroot bos vos peeters hendriks vanleeuwen dekker brouwer
dewit dijkstra smits degraaf vandermeer andersson johansson karlsson nilsson eriksson larsson olsson persson svensson
gustafsson pettersson jonsson jansson hansson bengtsson johansen pedersen nilsen kristiansen karlsen jorgensen madsen
kristensen olesen thomsen korhonen virtanen makinen nieminen makela hamalainen laine heikkinen koskinen jarvinen ferreira
pereira oliveira martins sousa goncalves lopes marques alves almeida ribeiro carvalho teixeira moreira correia mendes nunes
soares vieira monteiro cardoso neves coelho cunha pires reis simoes antunes matos fonseca machado araujo barbosa tavares yilmaz
kaya demir sahin celik yildiz yildirim ozturk aydin ozdemir arslan dogan kilic aslan cetin kara koc kurt ozkan simsek mizrahi
peretz biton katz goldberg rosenberg shapiro kaplan goldstein silverman feldman greenberg rosen stern horowitz adler altman
bachmann bader bartels bauer baumgartner beckmann bergmann binder bischoff blum brandt brinkmann busch dietrich doring ebert
eckert engel ernst fiedler forster frey fritz gartner geiger gerber graf haas hauser heinrich heinz henkel hermann hess
hildebrandt hirsch hoppe horn jager jahn kessler kirchner kluge knoll koller kramer kuhn kunz lenz lindner marx metzger
nagel naumann otto pfeiffer pohl rausch reuter ritter rudolph sauer schilling schlegel schreiber schuler seidel sommer
stahl steiner thiele ullrich vogt voigt wendt wirth ziegler aubert barbier benoit berger besson boucher boyer brun carpentier
charpentier collet colin cordier daniel david delmas denis deschamps dufour dupuis duval etienne gaillard gautier germain
giraud guillaume guillot hamon hubert huet jacob jacquet joly lacroix lamy langlois leclerc lecomte lemaire lemoine
leroux lucas maillard marchand marechal marie masson menard meunier michaud millet noel olivier paris pascal payet
perret philippe picard poirier prevost renard renaud rey riviere robin roche roger rolland royer schmitt tessier vasseur
vidal abate albanese alberti arena bassi belli benedetto bonetti bruni calabrese campana cirillo corsi cristiani davino
dimaggio falcone fumagalli fusco gagliardi garofalo guerrini guidi landi lazzari locatelli maggi magnani manfredi marras
marzano mele molinari napolitano nicoletti orsini pace pagani pavan piazza poli porcu ricciardi romeo rota ruggeri sacco
salvi simone spinelli tedesco tosi valente venturi villani visconti zanella zanetti antonov baranov belov bogdanov borisov
bykov danilov davydov denisov dmitriev efimov filippov frolov gavrilov golubev grigoriev gromov gusev ilyin kalinin
karpov kiselev komarov konovalov korolev krylov kudryavtsev kulikov kuzmin lazarev maksimov markov medvedev melnikov
mironov naumov nazarov osipov polyakov romanov ryabov savelyev shevchenko sidorov solovyov sorokin tarasov timofeev
titov vinogradov vlasov vorobyov yakovlev zaitsev zhukov adamczyk baran borkowski chmielewski czarnecki duda dudek
gajewski gorski grabowski jablonski jakubowski jasinski kaczmarek kalinowski kolodziej kubiak laskowski majewski
malinowski marciniak michalski nowakowski nowicki olszewski ostrowski pawlak pawlowski pietrzak piotrowski rutkowski
sadowski sikora sobczak stepien szczepanski tomaszewski walczak wieczorek witkowski wojciechowski wroblewski zajac
zalewski zawadzki abrahamsson axelsson bergstrom bjork blom dahl ekstrom engstrom forsberg hedlund holm isaksson
jakobsson lindberg lindgren lindqvist lindstrom lund lundberg lundgren lundqvist magnusson mattsson nordin nordstrom
nyberg nystrom sandberg sjoberg soderberg strom sundberg wallin wikstrom aalto ahonen anttila heinonen hiltunen
kallio karjalainen kinnunen laitinen lehtonen leppanen manninen mattila mustonen niemi ojala rantanen saarinen
salminen salonen savolainen tuominen turunen vaisanen abreu aguiar amaral andrade azevedo baptista barros batista
borges branco brito cabral campos castro cavaco domingues duarte esteves faria figueiredo freitas garcia gaspar
guerreiro henriques leite lima loureiro macedo magalhaes maia medeiros melo miranda morais mota moura nascimento
nogueira pacheco paiva pinheiro queiros rebelo sampaio santana sequeira vaz vicente xavier acar akin aksoy altun
avci bayram bozkurt bulut can coskun duman erdogan gunes isik kaplan karaca keskin korkmaz ozer polat sen tas
tekin toprak turan ucar unal yavuz yuksel`;

export const GIVEN = set(GIVEN_EN_M, GIVEN_EN_F, GIVEN_HISPANIC, GIVEN_SOUTH_ASIAN, GIVEN_EAST_ASIAN, GIVEN_ARABIC, GIVEN_AFRICAN, GIVEN_EUROPEAN);
export const SURNAMES = set(SURNAMES_EN, SURNAMES_SOUTH_ASIAN, SURNAMES_EAST_ASIAN, SURNAMES_ARABIC, SURNAMES_AFRICAN, SURNAMES_EUROPEAN);

/** Names that are also ordinary words, places, months or brands. Alone they are never treated as a name:
 *  they only count inside a two-word name such as "Will Turner". */
export const AMBIGUOUS = set(`will mark rose grace may hope bill jack art rich joy faith summer chase hunter mason april june august
autumn dawn eve iris ivy lily daisy violet olive ruby pearl amber jade crystal holly hazel heather ginger rosemary penny patience
charity mercy destiny trinity harmony melody sky skye river brook brooke brooks forest glen dale cliff heath reed wade ford lane
miles guy pat don gene jean ray rob rod sue drew grant frank earl duke king prince dean major bishop carol christian angel jesus
lance pierce chance chip buck buddy junior jay robin jordan georgia virginia carolina florence victoria austin dallas houston
madison lincoln jackson paris london brooklyn savannah charlotte sydney adelaide israel china india asia kenya chad troy eden zion
phoenix denver orlando santiago diego sage basil rowan ash jasper flint clay stone sterling ace bear wolf fox colt gray grey
scarlet scarlett ebony ivory star sunny misty sandy rocky rusty dusty lucky merry blossom honor justice liberty noble royal victor
max page piper parker cooper carter tanner sawyer marshall warren kent long fang ping sun young hung dung bo min soo mi nam thu
ha an my mai lan hong tao can per jan stan nova aurora genesis wren willow ember juniper maverick noel homer baron mercedes
chelsea brittany alexa dick cash crew legend saint titan king major noble diamond precious raven venus coral fern flora jewel
laurel pansy sierra valencia orion onyx remington kingston camden rhodes wells archer chandler porter ward angeles trinidad
dev son tin yen loan tone rune roar said nana german
white black brown green little day banks bell best bond booth bush case cross fish frost gold good hale hand hardy hart head
house hunt knight lamb law love lowe marsh mills moon park parks pope price short small snow spring steel street strong sweet
swift wall waters weaver webb west wise wood woods church branch cherry glass golden horn hood marks moss pace peck rush savage
sharp shepherd shields sparks spears stark stout summers walls winters york english french holland farmer fields flowers
gates graves gross hall key light lock lord low north south post read rice ring root sales sample sands silver singer
smart storm strange temple way weeks wild winter cook carpenter potter judge power powers rivers berry bean beard
booker bridges burns cannon combs crane curry dyer fry fuller glover hull lang mann mayo meadows noble person pitts
pool roach roman shell stamp stern trail worth`);

/** Capitalized words that are not names: roles, greetings, organizations, places, calendar words and
 *  function words. They cancel a cue match ("Hi Team") and cannot be the second word of a name. */
export const NOT_NAMES = set(`the a an and or but for with from to in on at by of is are was were be has have had do does did if
then when while my our your his her their this that these those it we you he she they i not no yes please thanks thank hi
hello dear hey regards sincerely cheers re fw fwd subject all everyone everybody team folks there sir madam customer customers
client clients support service services sales billing admin administrator help desk helpdesk info user users member members
agent agents manager management department office staff guest valued friend friends colleagues partner partners world
street st avenue ave road rd drive dr lane boulevard blvd way court place plaza square terrace highway parkway
inc corp corporation llc ltd co company group bank university college school hospital clinic foundation institute center
centre church hotel airport station park county city town village island islands river lake mountain mountains valley beach
bay hall house building tower bridge museum library stadium systems solutions technologies labs studio studios media press
award awards prize day week month year today tomorrow yesterday morning afternoon evening night monday tuesday wednesday
thursday friday saturday sunday january february march april june july august september october november december
said says confirmed wrote asked called replied added noted will can could should would may might must also just now here
new old north south east west central national international global general public private first second last next
note notes update updates summary report request response error warning status account order invoice payment ticket case
project product version release data file page section table figure appendix chapter part step item list
mr mrs ms miss mx prof doctor professor president director officer engineer developer analyst
america american states united kingdom europe european africa african asia asian english spanish french german
chinese japanese indian arabic italian russian`);
